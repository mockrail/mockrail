import type { ChargesService } from '../charges/charges.js';
import { ledgerAccounts } from '../ledger/ledger-entry.js';
import { compareMoney, type Money } from '../money/money.js';
import type { FailureReason, ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

export interface Refund {
  readonly id: string;
  readonly ownerId: string;
  readonly chargeId: string;
  readonly amount: Money;
  readonly status: RefundStatus;
  readonly reason: string | null;
  readonly failureReason: FailureReason | null;
  readonly plannedOutcome: ScenarioOutcome;
  readonly reference: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface CreateRefundInput {
  readonly ownerId: string;
  readonly chargeId: string;
  readonly amount?: Money | null;
  readonly reason?: string | null;
  readonly reference?: string | null;
  readonly metadata?: Metadata;
  readonly outcomeOverride?: ScenarioOutcome;
  /** Some providers block API refunds of bank deposits in live mode. */
  readonly allowDepositRefunds: boolean;
}

const FINALIZE_JOB = 'refund.finalize';
const REFUNDABLE = new Set(['succeeded', 'overpaid', 'underpaid']);

export class RefundsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly charges: ChargesService,
  ) {
    ctx.scheduler.register<{ refundId: string }>(FINALIZE_JOB, ({ refundId }) => this.finalize(refundId));
  }

  create(input: CreateRefundInput): Refund {
    const charge = this.charges.get(input.ownerId, input.chargeId);
    if (charge.source === 'deposit' && !input.allowDepositRefunds) {
      throw new SandboxError('refund_not_allowed', 'Bank deposits cannot be refunded via the API.');
    }
    if (!REFUNDABLE.has(charge.status)) {
      throw new SandboxError('invalid_state', `Payment ${charge.id} is ${charge.status} and cannot be refunded.`);
    }
    const remaining = this.charges.refundableAmount(charge);
    const amount = input.amount ?? remaining;
    if (amount.currency !== charge.amount.currency) throw validationFailed([{ field: 'amount', message: 'Refund currency must match the payment.' }]);
    if (amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
    if (compareMoney(amount, remaining) > 0) {
      throw validationFailed([{ field: 'amount', message: 'Amount exceeds the refundable remainder of the payment.' }], 'Refund amount exceeds the refundable amount.');
    }

    const plannedOutcome = this.ctx.scenarios.decide(
      { operation: 'refund.create', references: [charge.id, input.reference], ownerId: input.ownerId, currency: amount.currency },
      input.outcomeOverride,
    );
    const now = this.ctx.nowIso();
    const refund: Refund = {
      id: this.ctx.ids.next('re'),
      ownerId: input.ownerId,
      chargeId: charge.id,
      amount,
      status: 'pending',
      reason: input.reason ?? null,
      failureReason: null,
      plannedOutcome,
      reference: input.reference ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      completedAt: null,
      updatedAt: now,
    };
    this.ctx.store.put(C.refunds, refund);
    this.charges.adjustRefunded(charge.id, amount);
    this.ctx.ledger.move(ledgerAccounts.balance(refund.ownerId, 'available'), ledgerAccounts.external('refunds'), amount, `refund ${refund.id}`, refund.id);
    const delay = this.ctx.config.refundSettleDelayMs + (plannedOutcome.kind === 'delay' ? plannedOutcome.settleAfterMs : 0);
    this.ctx.scheduler.schedule(FINALIZE_JOB, new Date(this.ctx.now().getTime() + delay), { refundId: refund.id });
    this.ctx.events.publish('refund.created', refund.ownerId, { refund, charge: this.charges.find(charge.id) });
    return refund;
  }

  get(ownerId: string, id: string): Refund {
    const refund = this.ctx.store.get<Refund>(C.refunds, id);
    if (!refund || refund.ownerId !== ownerId) throw notFound('refund', id);
    return refund;
  }

  list(ownerId: string, filter: { readonly chargeId?: string } = {}): Refund[] {
    return this.ctx.store
      .list<Refund>(C.refunds, (r) => r.ownerId === ownerId && (!filter.chargeId || r.chargeId === filter.chargeId))
      .sort(byNewest);
  }

  private finalize(refundId: string): void {
    const refund = this.ctx.store.get<Refund>(C.refunds, refundId);
    if (!refund || refund.status !== 'pending') return;
    const now = this.ctx.nowIso();
    if (refund.plannedOutcome.kind === 'fail') {
      const failed = this.save({ ...refund, status: 'failed', failureReason: refund.plannedOutcome.reason, completedAt: now });
      this.charges.adjustRefunded(refund.chargeId, { ...refund.amount, amountMinor: -refund.amount.amountMinor });
      this.ctx.ledger.move(ledgerAccounts.external('refunds'), ledgerAccounts.balance(refund.ownerId, 'available'), refund.amount, `refund failed ${refund.id}`, refund.id);
      this.ctx.events.publish('refund.failed', failed.ownerId, { refund: failed, charge: this.charges.find(refund.chargeId) });
      return;
    }
    const done = this.save({ ...refund, status: 'succeeded', completedAt: now });
    const charge = this.charges.find(refund.chargeId);
    this.ctx.events.publish('refund.succeeded', done.ownerId, { refund: done, charge });
    if (charge) this.ctx.events.publish('charge.refunded', charge.ownerId, { charge, refund: done });
  }

  private save(refund: Refund): Refund {
    const next = { ...refund, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.refunds, next);
    return next;
  }
}
