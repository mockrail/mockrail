import { ledgerAccounts, type BalanceBucket, type LedgerLine } from '../ledger/ledger-entry.js';
import { compareMoney, money, subtractMoney, zero, type Money } from '../money/money.js';
import type { FailureReason, OperationName, ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed, type FieldError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { PLATFORM_OWNER } from '../shared/owners.js';
import type { AccountsService } from '../connect/accounts.js';
import type { TransfersService } from '../connect/transfers.js';

/** Provider-neutral charge lifecycle. Adapters map these to their own status words. */
export type ChargeStatus = 'pending' | 'succeeded' | 'underpaid' | 'overpaid' | 'failed';

export type ChargeSource = 'api' | 'checkout' | 'invoice' | 'deposit';

export type PaymentMethod =
  | { readonly type: 'card'; readonly last4: string; readonly brand: string; readonly fingerprint: string }
  | {
      readonly type: 'bank_transfer';
      readonly senderName: string | null;
      readonly senderAccountNumber: string | null;
      readonly senderBankName: string | null;
    }
  | { readonly type: 'crypto'; readonly network: string | null; readonly asset: string | null }
  | { readonly type: 'mobile_money'; readonly phone: string | null; readonly provider: string | null };

export type SettlementState = 'none' | 'pending' | 'available' | 'held';

export interface SettlementSplit {
  readonly ownerId: string;
  readonly amountMinor: bigint;
}

export interface Charge {
  readonly id: string;
  readonly ownerId: string;
  readonly source: ChargeSource;
  readonly checkoutId: string | null;
  readonly invoiceId: string | null;
  readonly subscriptionId: string | null;
  readonly virtualAccountId: string | null;
  readonly customerId: string | null;
  readonly amount: Money;
  readonly amountReceived: Money;
  readonly amountRefunded: Money;
  readonly status: ChargeStatus;
  readonly failureReason: FailureReason | null;
  readonly paymentMethod: PaymentMethod | null;
  /** Outcome decided when the charge was created; applied when it finalizes. */
  readonly plannedOutcome: ScenarioOutcome;
  readonly delayApplied: boolean;
  readonly platformFee: Money | null;
  readonly transferDestination: string | null;
  readonly transferAmount: Money | null;
  readonly settlement: SettlementState;
  readonly settlementSplits: readonly SettlementSplit[];
  readonly description: string | null;
  readonly reference: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly finalizedAt: string | null;
  readonly updatedAt: string;
}

export interface CreateChargeInput {
  readonly ownerId: string;
  readonly amount: Money;
  readonly customerId?: string | null;
  readonly paymentMethod: PaymentMethod;
  readonly platformFee?: Money | null;
  readonly transferDestination?: string | null;
  readonly transferAmount?: Money | null;
  readonly description?: string | null;
  readonly reference?: string | null;
  readonly metadata?: Metadata;
  /** Outcome forced by the adapter (test cards) or a per-request scenario header. */
  readonly outcomeOverride?: ScenarioOutcome;
}

interface InternalCreate extends CreateChargeInput {
  readonly source: ChargeSource;
  readonly checkoutId?: string | null;
  readonly invoiceId?: string | null;
  readonly subscriptionId?: string | null;
  readonly virtualAccountId?: string | null;
  readonly operation: OperationName;
}

export type ChargeFinalizedListener = (charge: Charge) => void;

const FINALIZE_JOB = 'charge.finalize';
const SETTLE_JOB = 'charge.settle';

export class ChargesService {
  private readonly listeners: ChargeFinalizedListener[] = [];

  constructor(
    private readonly ctx: CoreContext,
    private readonly accounts: AccountsService,
    private readonly transfers: TransfersService,
  ) {
    ctx.scheduler.register<{ chargeId: string }>(FINALIZE_JOB, ({ chargeId }) => this.finalize(chargeId));
    ctx.scheduler.register<{ chargeId: string }>(SETTLE_JOB, ({ chargeId }) => this.settle(chargeId));
  }

  /** Called after any charge reaches a final state (used by checkout and billing). */
  onFinalized(listener: ChargeFinalizedListener): void {
    this.listeners.push(listener);
  }

  /** A direct API charge. Finalizes after the configured delay. */
  create(input: CreateChargeInput): Charge {
    return this.createPending({ ...input, source: 'api', operation: 'charge.create' });
  }

  createForCheckout(input: CreateChargeInput & { readonly checkoutId: string }): Charge {
    return this.createPending({ ...input, source: 'checkout', operation: 'checkout.pay' });
  }

  /** Charges a saved payment method for an invoice and finalizes immediately. */
  chargeInvoice(input: CreateChargeInput & { readonly invoiceId: string; readonly subscriptionId: string }): Charge {
    const charge = this.build({ ...input, source: 'invoice', operation: 'subscription.renew' });
    this.ctx.store.put(C.charges, charge);
    this.ctx.events.publish('charge.created', charge.ownerId, this.eventData(charge));
    return this.applyOutcome(charge, charge.plannedOutcome);
  }

  /** A bank deposit into a virtual account: succeeds at once. Held deposits keep funds pending. */
  recordDeposit(input: {
    readonly ownerId: string;
    readonly amount: Money;
    readonly virtualAccountId: string;
    readonly customerId: string | null;
    readonly paymentMethod: PaymentMethod;
    readonly reference: string | null;
    readonly held: boolean;
  }): Charge {
    const charge = this.build({ ...input, source: 'deposit', operation: 'deposit.receive', outcomeOverride: { kind: 'succeed' } });
    this.ctx.store.put(C.charges, charge);
    this.ctx.events.publish('charge.created', charge.ownerId, this.eventData(charge));
    return this.applyOutcome(charge, { kind: 'succeed' }, { held: input.held });
  }

  get(ownerId: string, id: string): Charge {
    const charge = this.ctx.store.get<Charge>(C.charges, id);
    if (!charge || charge.ownerId !== ownerId) throw notFound('payment', id);
    return charge;
  }

  find(id: string | null | undefined): Charge | null {
    return id ? this.ctx.store.get<Charge>(C.charges, id) ?? null : null;
  }

  list(
    ownerId: string,
    filter: {
      readonly customerId?: string;
      readonly status?: ChargeStatus;
      readonly source?: ChargeSource;
      readonly paymentMethodType?: PaymentMethod['type'];
      readonly checkoutId?: string;
    } = {},
  ): Charge[] {
    return this.ctx.store
      .list<Charge>(C.charges, (c) => {
        if (c.ownerId !== ownerId) return false;
        if (filter.customerId && c.customerId !== filter.customerId) return false;
        if (filter.status && c.status !== filter.status) return false;
        if (filter.source && c.source !== filter.source) return false;
        if (filter.paymentMethodType && c.paymentMethod?.type !== filter.paymentMethodType) return false;
        if (filter.checkoutId && c.checkoutId !== filter.checkoutId) return false;
        return true;
      })
      .sort(byNewest);
  }

  /** Records a change in refunded amount (positive while refunding, negative when a refund fails). */
  adjustRefunded(chargeId: string, delta: Money): Charge {
    const charge = this.ctx.store.get<Charge>(C.charges, chargeId);
    if (!charge) throw notFound('payment', chargeId);
    const next: Charge = {
      ...charge,
      amountRefunded: money(charge.amountRefunded.amountMinor + delta.amountMinor, charge.amount.currency),
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.charges, next);
    return next;
  }

  /** Releases funds of a held deposit into the available balance. */
  releaseHeld(chargeId: string): Charge {
    const charge = this.ctx.store.get<Charge>(C.charges, chargeId);
    if (!charge) throw notFound('payment', chargeId);
    if (charge.settlement !== 'held') throw new SandboxError('invalid_state', `Payment ${chargeId} is not held.`);
    this.moveToAvailable(charge, 'release held deposit');
    const next = this.save({ ...charge, settlement: 'available' });
    this.ctx.events.publish('deposit.released', next.ownerId, this.eventData(next));
    return next;
  }

  refundableAmount(charge: Charge): Money {
    return subtractMoney(charge.amountReceived, charge.amountRefunded);
  }

  // ---------------------------------------------------------------------------

  private createPending(input: InternalCreate): Charge {
    const charge = this.build(input);
    this.ctx.store.put(C.charges, charge);
    this.ctx.events.publish('charge.created', charge.ownerId, this.eventData(charge));
    this.ctx.scheduler.schedule(FINALIZE_JOB, new Date(this.ctx.now().getTime() + this.ctx.config.chargeFinalizeDelayMs), { chargeId: charge.id }, {
      key: `charge-finalize:${charge.id}`,
    });
    return charge;
  }

  private build(input: InternalCreate): Charge {
    this.validate(input);
    const plannedOutcome = this.ctx.scenarios.decide(
      {
        operation: input.operation,
        references: [input.reference, input.customerId, input.checkoutId, input.subscriptionId, input.virtualAccountId],
        ownerId: input.ownerId,
        currency: input.amount.currency,
      },
      input.outcomeOverride,
    );
    const now = this.ctx.nowIso();
    return {
      id: this.ctx.ids.next('ch'),
      ownerId: input.ownerId,
      source: input.source,
      checkoutId: input.checkoutId ?? null,
      invoiceId: input.invoiceId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      virtualAccountId: input.virtualAccountId ?? null,
      customerId: input.customerId ?? null,
      amount: input.amount,
      amountReceived: zero(input.amount.currency),
      amountRefunded: zero(input.amount.currency),
      status: 'pending',
      failureReason: null,
      paymentMethod: input.paymentMethod,
      plannedOutcome,
      delayApplied: false,
      platformFee: input.platformFee ?? null,
      transferDestination: input.transferDestination ?? null,
      transferAmount: input.transferAmount ?? null,
      settlement: 'none',
      settlementSplits: [],
      description: input.description ?? null,
      reference: input.reference ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      paidAt: now,
      finalizedAt: null,
      updatedAt: now,
    };
  }

  private validate(input: InternalCreate): void {
    const errors: FieldError[] = [];
    if (input.amount.amountMinor <= 0n) errors.push({ field: 'amount', message: 'Amount must be greater than zero.' });
    if (input.platformFee) {
      if (input.platformFee.currency !== input.amount.currency) errors.push({ field: 'platform_fee', message: 'Fee currency must match the charge.' });
      else if (input.platformFee.amountMinor < 0n || compareMoney(input.platformFee, input.amount) > 0) {
        errors.push({ field: 'platform_fee', message: 'Fee must be between zero and the charge amount.' });
      }
      if (input.ownerId === PLATFORM_OWNER && !input.transferDestination) {
        errors.push({ field: 'platform_fee', message: 'A platform fee needs a connected account (direct or destination charge).' });
      }
    }
    if (input.transferAmount && (input.transferAmount.currency !== input.amount.currency || compareMoney(input.transferAmount, input.amount) > 0)) {
      errors.push({ field: 'transfer_data.amount', message: 'Transfer amount must be in the charge currency and not exceed it.' });
    }
    if (input.transferDestination && !this.accounts.find(input.transferDestination)) {
      errors.push({ field: 'transfer_data.destination', message: `No account found with id '${input.transferDestination}'.` });
    }
    if (errors.length) throw validationFailed(errors);
  }

  private finalize(chargeId: string): void {
    const charge = this.ctx.store.get<Charge>(C.charges, chargeId);
    if (!charge || charge.status !== 'pending') return;
    const outcome = charge.plannedOutcome;
    if (outcome.kind === 'delay' && !charge.delayApplied) {
      this.save({ ...charge, delayApplied: true });
      this.ctx.scheduler.schedule(FINALIZE_JOB, new Date(this.ctx.now().getTime() + outcome.settleAfterMs), { chargeId }, {
        key: `charge-finalize:${chargeId}`,
      });
      return;
    }
    this.applyOutcome(charge, outcome);
  }

  private applyOutcome(charge: Charge, outcome: ScenarioOutcome, options: { readonly held?: boolean } = {}): Charge {
    const finalizedAt = this.ctx.nowIso();
    if (outcome.kind === 'fail') {
      const failed = this.save({ ...charge, status: 'failed', failureReason: outcome.reason, finalizedAt });
      this.ctx.events.publish('charge.failed', failed.ownerId, this.eventData(failed));
      this.notify(failed);
      return failed;
    }

    const received = outcome.kind === 'partial' ? outcome.receivedAmount : charge.amount;
    if (received.currency !== charge.amount.currency) {
      throw new SandboxError('bad_request', 'Partial payment currency must match the charge currency.');
    }
    const comparison = compareMoney(received, charge.amount);
    const status: ChargeStatus = comparison < 0 ? 'underpaid' : comparison > 0 ? 'overpaid' : 'succeeded';
    const { splits, settlement } = this.creditFunds(charge, received, options.held ?? false);
    const done = this.save({
      ...charge,
      status,
      amountReceived: received,
      settlement,
      settlementSplits: splits,
      finalizedAt,
    });

    if (status !== 'underpaid') this.recordConnectSideEffects(done, received);
    this.ctx.events.publish(status === 'underpaid' ? 'charge.underpaid' : 'charge.succeeded', done.ownerId, this.eventData(done));
    if (settlement === 'held') this.ctx.events.publish('deposit.held', done.ownerId, this.eventData(done));
    this.notify(done);
    return done;
  }

  /** Posts the incoming money to the ledger, split between the charge owner and any connected party. */
  private creditFunds(charge: Charge, received: Money, held: boolean): { splits: SettlementSplit[]; settlement: SettlementState } {
    const splits = this.computeSplits(charge, received);
    const live = this.ctx.config.fidelity === 'live' && charge.source !== 'deposit';
    const bucket: BalanceBucket = held || live ? 'pending' : 'available';
    const lines: LedgerLine[] = [{ account: ledgerAccounts.external(railFor(charge.paymentMethod)), direction: 'debit', amount: received }];
    for (const split of splits) {
      lines.push({ account: ledgerAccounts.balance(split.ownerId, bucket), direction: 'credit', amount: money(split.amountMinor, received.currency) });
    }
    this.ctx.ledger.post({ description: `charge ${charge.id}`, reference: charge.id, lines });

    if (held) return { splits, settlement: 'held' };
    if (live) {
      this.ctx.scheduler.schedule(SETTLE_JOB, new Date(this.ctx.now().getTime() + this.ctx.config.liveSettlementDelayMs), { chargeId: charge.id }, {
        key: `charge-settle:${charge.id}`,
      });
      return { splits, settlement: 'pending' };
    }
    return { splits, settlement: 'available' };
  }

  private computeSplits(charge: Charge, received: Money): SettlementSplit[] {
    const total = received.amountMinor;
    if (charge.transferDestination) {
      const toDestination = charge.transferAmount
        ? charge.transferAmount.amountMinor
        : total - (charge.platformFee?.amountMinor ?? 0n);
      const clamped = toDestination < 0n ? 0n : toDestination > total ? total : toDestination;
      return [
        { ownerId: charge.ownerId, amountMinor: total - clamped },
        { ownerId: charge.transferDestination, amountMinor: clamped },
      ].filter((s) => s.amountMinor > 0n);
    }
    if (charge.platformFee && charge.ownerId !== PLATFORM_OWNER) {
      const fee = charge.platformFee.amountMinor > total ? total : charge.platformFee.amountMinor;
      return [
        { ownerId: charge.ownerId, amountMinor: total - fee },
        { ownerId: PLATFORM_OWNER, amountMinor: fee },
      ].filter((s) => s.amountMinor > 0n);
    }
    return [{ ownerId: charge.ownerId, amountMinor: total }];
  }

  private recordConnectSideEffects(charge: Charge, received: Money): void {
    if (charge.transferDestination) {
      const split = charge.settlementSplits.find((s) => s.ownerId === charge.transferDestination);
      if (split) this.transfers.recordFromCharge({ destination: charge.transferDestination, amount: money(split.amountMinor, received.currency), chargeId: charge.id });
      if (charge.platformFee && charge.platformFee.amountMinor > 0n) {
        this.transfers.recordPlatformFee({ accountId: charge.transferDestination, chargeId: charge.id, amount: charge.platformFee });
      }
    } else if (charge.platformFee && charge.platformFee.amountMinor > 0n && charge.ownerId !== PLATFORM_OWNER) {
      this.transfers.recordPlatformFee({ accountId: charge.ownerId, chargeId: charge.id, amount: charge.platformFee });
    }
  }

  private settle(chargeId: string): void {
    const charge = this.ctx.store.get<Charge>(C.charges, chargeId);
    if (!charge || charge.settlement !== 'pending') return;
    this.moveToAvailable(charge, `settle charge ${charge.id}`);
    const next = this.save({ ...charge, settlement: 'available' });
    this.ctx.events.publish('charge.settled', next.ownerId, this.eventData(next));
  }

  private moveToAvailable(charge: Charge, description: string): void {
    const lines: LedgerLine[] = [];
    for (const split of charge.settlementSplits) {
      const amount = money(split.amountMinor, charge.amount.currency);
      lines.push({ account: ledgerAccounts.balance(split.ownerId, 'pending'), direction: 'debit', amount });
      lines.push({ account: ledgerAccounts.balance(split.ownerId, 'available'), direction: 'credit', amount });
    }
    this.ctx.ledger.post({ description, reference: charge.id, lines });
  }

  private save(charge: Charge): Charge {
    const next = { ...charge, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.charges, next);
    return next;
  }

  private notify(charge: Charge): void {
    for (const listener of this.listeners) listener(charge);
  }

  eventData(charge: Charge): Record<string, unknown> {
    return { charge };
  }
}

function railFor(method: PaymentMethod | null): 'card_network' | 'bank_transfer' | 'crypto' | 'mobile_money' {
  switch (method?.type) {
    case 'bank_transfer':
      return 'bank_transfer';
    case 'crypto':
      return 'crypto';
    case 'mobile_money':
      return 'mobile_money';
    default:
      return 'card_network';
  }
}
