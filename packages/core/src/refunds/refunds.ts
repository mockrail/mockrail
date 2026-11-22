import type { ChargesService } from '../charges/charges.js';
import { ledgerAccounts } from '../ledger/ledger-entry.js';
import { compareMoney, zero, type Money } from '../money/money.js';
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
  readonly fee: Money;
  readonly feeBearer: 'merchant' | 'customer';
  readonly status: RefundStatus;
  readonly reason: string | null;
  readonly failureReason: FailureReason | null;
  readonly plannedOutcome: ScenarioOutcome;
  readonly reference: string | null;
  readonly refundAddress: string | null;
  readonly idempotencyKey: string | null;
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
  readonly refundAddress?: string | null;
  readonly feeBearer?: 'merchant' | 'customer';
  /** Same key on the same charge within `idempotencyWindowMs` returns the existing refund. */
  readonly idempotencyKey?: string | null;
  readonly idempotencyWindowMs?: number;
  readonly metadata?: Metadata;
  readonly outcomeOverride?: ScenarioOutcome;
  /** Some providers block API refunds of bank transfers. */
  readonly allowBankTransferRefunds: boolean;
  /** Some providers allow only one non-failed refund per charge. */
  readonly singleRefundPerCharge?: boolean;
}

const FINALIZE_JOB = 'refund.finalize';
const REFUNDABLE = new Set(['succeeded', 'overpaid', 'underpaid']);

function refundError(code: 'conflict' | 'refund_not_allowed' | 'invalid_state', reason: string, message: string): SandboxError {
  return new SandboxError(code, message, { details: { reason } });
}

export class RefundsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly charges: ChargesService,
  ) {
    ctx.scheduler.register<{ refundId: string }>(FINALIZE_JOB, ({ refundId }) => this.finalize(refundId));
  }

  /** Returns `{ refund, created: false }` for an idempotent replay. */
  create(input: CreateRefundInput): { refund: Refund; created: boolean } {
    const charge = this.charges.get(input.ownerId, input.chargeId);
    if (input.idempotencyKey) {
      const window = input.idempotencyWindowMs ?? Number.POSITIVE_INFINITY;
      const replay = this.list(input.ownerId, { chargeId: charge.id }).find(
        (r) => r.idempotencyKey === input.idempotencyKey && this.ctx.now().getTime() - Date.parse(r.createdAt) < window,
      );
      if (replay) return { refund: replay, created: false };
    }
    if (input.reference && this.list(input.ownerId).some((r) => r.reference === input.reference)) {
      throw refundError('conflict', 'duplicate_reference', 'Refund reference already exists.');
    }
    if (charge.paymentMethod?.type === 'bank_transfer' && !input.allowBankTransferRefunds) {
      throw refundError('refund_not_allowed', 'refunds_not_supported', 'Refunds are not supported for this charge.');
    }
    if (!REFUNDABLE.has(charge.status)) {
      throw refundError('refund_not_allowed', 'charge_not_refundable', `Charge is not refundable in status "${charge.status}".`);
    }
    if (input.singleRefundPerCharge && this.list(input.ownerId, { chargeId: charge.id }).some((r) => r.status !== 'failed')) {
      throw refundError('conflict', 'refund_exists', 'A refund already exists for this charge.');
    }
    if (charge.paymentMethod?.type === 'crypto' && !input.refundAddress) {
      throw validationFailed([{ field: 'refund_address', message: 'Crypto refunds need a refund_address on the same network.' }]);
    }
    const remaining = this.charges.refundableAmount(charge);
    const amount = input.amount ?? remaining;
    if (amount.currency !== charge.amount.currency) throw validationFailed([{ field: 'amount', message: 'Refund currency must match the payment.' }]);
    if (amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
    if (compareMoney(amount, remaining) > 0) {
      throw refundError('refund_not_allowed', 'amount_exceeds_refundable', `Refund amount exceeds refundable balance.`);
    }

    const plannedOutcome = this.ctx.scenarios.decide(
      { operation: 'refund.create', references: [charge.id, input.reference], ownerId: input.ownerId, currency: amount.currency },
      input.outcomeOverride,
    );
    const now = this.ctx.nowIso();
    const refund: Refund = {
      id: this.ctx.ids.entity('refund', input.ownerId),
      ownerId: input.ownerId,
      chargeId: charge.id,
      amount,
      fee: zero(amount.currency),
      feeBearer: input.feeBearer ?? 'merchant',
      status: 'pending',
      reason: input.reason ?? null,
      failureReason: null,
      plannedOutcome,
      reference: input.reference ?? null,
      refundAddress: input.refundAddress ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
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
    return { refund, created: true };
  }

  get(ownerId: string, id: string): Refund {
    const refund = this.ctx.store.get<Refund>(C.refunds, id);
    if (!refund || refund.ownerId !== ownerId) throw notFound('refund', id);
    return refund;
  }

  list(ownerId: string, filter: { readonly chargeId?: string; readonly status?: RefundStatus } = {}): Refund[] {
    return this.ctx.store
      .list<Refund>(C.refunds, (r) => r.ownerId === ownerId && (!filter.chargeId || r.chargeId === filter.chargeId) && (!filter.status || r.status === filter.status))
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
