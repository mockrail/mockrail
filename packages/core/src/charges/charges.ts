import { ledgerAccounts, type BalanceBucket, type LedgerLine } from '../ledger/ledger-entry.js';
import { compareMoney, money, subtractMoney, zero, type Money } from '../money/money.js';
import type { FailureReason, OperationName, ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed, type FieldError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { isPlatformOwner, ownerId as makeOwner, platformOf, providerOf } from '../shared/owners.js';
import type { AccountsService } from '../connect/accounts.js';
import type { TransfersService } from '../connect/transfers.js';

/** Provider-neutral charge lifecycle. Adapters map these to their own status words. */
export type ChargeStatus = 'pending' | 'succeeded' | 'underpaid' | 'overpaid' | 'failed';

export type ChargeSource = 'api' | 'checkout' | 'invoice' | 'deposit';

export type PaymentMethod =
  | {
      readonly type: 'card';
      readonly last4: string;
      readonly brand: string;
      readonly fingerprint: string;
      readonly expMonth?: number;
      readonly expYear?: number;
      readonly currency?: string;
    }
  | {
      readonly type: 'bank_transfer';
      readonly senderName: string | null;
      readonly senderAccountNumber: string | null;
      readonly senderBankName: string | null;
      readonly senderBankCode?: string | null;
      readonly sessionId?: string | null;
      readonly narration?: string | null;
    }
  | { readonly type: 'crypto'; readonly network: string | null; readonly asset: string | null }
  | { readonly type: 'mobile_money'; readonly phone: string | null; readonly provider: string | null };

export type SettlementState = 'none' | 'pending' | 'available' | 'held';

export interface SettlementSplit {
  readonly ownerId: string;
  readonly amountMinor: bigint;
}

/** Processing fee rule, stored on the charge so it can be applied when the charge finalizes. */
export interface FeeRule {
  /** Basis points of the amount received (150 = 1.5%). */
  readonly percentBps: number;
  readonly flatMinor?: bigint;
  readonly minMinor?: bigint | null;
  readonly capMinor?: bigint | null;
}

export interface StatusChange {
  readonly status: string;
  readonly occurredAt: string;
  readonly reason: string | null;
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
  readonly savedPaymentMethodId: string | null;
  readonly amount: Money;
  readonly amountReceived: Money;
  readonly amountRefunded: Money;
  readonly processingFee: Money | null;
  readonly feeRule: FeeRule | null;
  readonly status: ChargeStatus;
  readonly failureReason: FailureReason | null;
  readonly paymentMethod: PaymentMethod | null;
  /** Outcome decided when the charge was created; applied when it finalizes. */
  readonly plannedOutcome: ScenarioOutcome;
  readonly delayApplied: boolean;
  readonly platformFee: Money | null;
  /** Connected account id receiving a destination charge. */
  readonly transferDestination: string | null;
  readonly transferAmount: Money | null;
  readonly settlement: SettlementState;
  readonly settlementSplits: readonly SettlementSplit[];
  readonly description: string | null;
  readonly reference: string | null;
  readonly metadata: Metadata;
  readonly statusHistory: readonly StatusChange[];
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
  readonly savedPaymentMethodId?: string | null;
  readonly feeRule?: FeeRule | null;
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

export function applyFeeRule(rule: FeeRule | null | undefined, received: Money): Money | null {
  if (!rule) return null;
  let fee = (received.amountMinor * BigInt(rule.percentBps)) / 10_000n + (rule.flatMinor ?? 0n);
  if (rule.minMinor != null && fee < rule.minMinor) fee = rule.minMinor;
  if (rule.capMinor != null && fee > rule.capMinor) fee = rule.capMinor;
  if (fee > received.amountMinor) fee = received.amountMinor;
  return money(fee, received.currency);
}

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
    this.ctx.events.publish('charge.created', charge.ownerId, { charge });
    return this.applyOutcome(charge, charge.plannedOutcome);
  }

  /** A bank deposit into a virtual account: succeeds at once. Held deposits go to the held bucket. */
  recordDeposit(input: {
    readonly ownerId: string;
    readonly amount: Money;
    readonly virtualAccountId: string;
    readonly customerId: string | null;
    readonly paymentMethod: PaymentMethod;
    readonly reference: string | null;
    readonly feeRule?: FeeRule | null;
    readonly held: boolean;
  }): Charge {
    const charge = this.build({ ...input, source: 'deposit', operation: 'deposit.receive', outcomeOverride: { kind: 'succeed' } });
    this.ctx.store.put(C.charges, charge);
    this.ctx.events.publish('charge.created', charge.ownerId, { charge });
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
    return this.save({ ...charge, amountRefunded: money(charge.amountRefunded.amountMinor + delta.amountMinor, charge.amount.currency) });
  }

  /** Releases a held deposit into the available balance. Sends no event. */
  releaseHeld(chargeId: string): Charge {
    const charge = this.ctx.store.get<Charge>(C.charges, chargeId);
    if (!charge) throw notFound('payment', chargeId);
    if (charge.settlement !== 'held') throw new SandboxError('invalid_state', `Payment ${chargeId} is not held.`);
    this.moveBucket(charge, 'held', 'available', 'release held deposit');
    const next = this.save({ ...charge, settlement: 'available' });
    this.ctx.events.publish('deposit.released', next.ownerId, { charge: next });
    return next;
  }

  refundableAmount(charge: Charge): Money {
    return subtractMoney(charge.amountReceived, charge.amountRefunded);
  }

  /** Owner string for a connected account in the same provider as `owner`. */
  accountOwner(owner: string, accountId: string): string {
    return makeOwner(providerOf(owner), accountId);
  }

  // ---------------------------------------------------------------------------

  private createPending(input: InternalCreate): Charge {
    const charge = this.build(input);
    this.ctx.store.put(C.charges, charge);
    this.ctx.events.publish('charge.created', charge.ownerId, { charge });
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
      id: this.ctx.ids.entity('charge', input.ownerId),
      ownerId: input.ownerId,
      source: input.source,
      checkoutId: input.checkoutId ?? null,
      invoiceId: input.invoiceId ?? null,
      subscriptionId: input.subscriptionId ?? null,
      virtualAccountId: input.virtualAccountId ?? null,
      customerId: input.customerId ?? null,
      savedPaymentMethodId: input.savedPaymentMethodId ?? null,
      amount: input.amount,
      amountReceived: zero(input.amount.currency),
      amountRefunded: zero(input.amount.currency),
      processingFee: null,
      feeRule: input.feeRule ?? null,
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
      statusHistory: [{ status: 'pending', occurredAt: now, reason: null }],
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
      else if (input.platformFee.amountMinor < 0n || compareMoney(input.platformFee, input.amount) >= 0) {
        errors.push({ field: 'platform_fee', message: 'Fee must be less than the charge amount.' });
      }
      if (isPlatformOwner(input.ownerId) && !input.transferDestination) {
        errors.push({ field: 'platform_fee', message: 'A platform fee needs a connected account (direct or destination charge).' });
      }
    }
    if (input.transferAmount && (input.transferAmount.currency !== input.amount.currency || compareMoney(input.transferAmount, input.amount) >= 0)) {
      errors.push({ field: 'transfer_data.amount', message: 'Transfer amount must be in the charge currency and less than it.' });
    }
    if (input.transferDestination) {
      const account = this.accounts.find(input.transferDestination);
      if (!account || account.platformOwnerId !== platformOf(input.ownerId)) {
        errors.push({ field: 'transfer_data.destination', message: `No account found with id '${input.transferDestination}'.` });
      }
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
      const failed = this.save({
        ...charge,
        status: 'failed',
        failureReason: outcome.reason,
        finalizedAt,
        statusHistory: [...charge.statusHistory, { status: 'failed', occurredAt: finalizedAt, reason: outcome.reason }],
      });
      this.ctx.events.publish('charge.failed', failed.ownerId, { charge: failed });
      this.notify(failed);
      return failed;
    }

    const received = outcome.kind === 'partial' ? outcome.receivedAmount : charge.amount;
    if (received.currency !== charge.amount.currency) {
      throw new SandboxError('bad_request', 'Partial payment currency must match the charge currency.');
    }
    const comparison = compareMoney(received, charge.amount);
    const status: ChargeStatus = comparison < 0 ? 'underpaid' : comparison > 0 ? 'overpaid' : 'succeeded';
    const processingFee = applyFeeRule(charge.feeRule, received);
    const { splits, settlement } = this.creditFunds(charge, received, processingFee, options.held ?? false);
    const done = this.save({
      ...charge,
      status,
      amountReceived: received,
      processingFee,
      settlement,
      settlementSplits: splits,
      finalizedAt,
      statusHistory: [...charge.statusHistory, { status, occurredAt: finalizedAt, reason: null }],
    });

    if (status !== 'underpaid') this.recordConnectSideEffects(done, received);
    this.ctx.events.publish(status === 'underpaid' ? 'charge.underpaid' : 'charge.succeeded', done.ownerId, { charge: done });
    if (settlement === 'held') this.ctx.events.publish('deposit.held', done.ownerId, { charge: done });
    this.notify(done);
    return done;
  }

  /** Posts the incoming money: processing fee to the provider, the rest split between owner and connected party. */
  private creditFunds(charge: Charge, received: Money, fee: Money | null, held: boolean): { splits: SettlementSplit[]; settlement: SettlementState } {
    const splits = this.computeSplits(charge, received, fee?.amountMinor ?? 0n);
    const live = this.ctx.config.fidelity === 'live' && charge.source !== 'deposit';
    const bucket: BalanceBucket = held ? 'held' : live ? 'pending' : 'available';
    const lines: LedgerLine[] = [{ account: ledgerAccounts.external(railFor(charge.paymentMethod)), direction: 'debit', amount: received }];
    if (fee && fee.amountMinor > 0n) lines.push({ account: ledgerAccounts.external('provider_fees'), direction: 'credit', amount: fee });
    for (const split of splits) {
      lines.push({
        account: ledgerAccounts.balance(split.ownerId, bucket),
        direction: split.amountMinor >= 0n ? 'credit' : 'debit',
        amount: money(split.amountMinor >= 0n ? split.amountMinor : -split.amountMinor, received.currency),
      });
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

  /**
   * Destination charge: the platform is merchant of record and bears the processing fee; the account
   * gets the gross minus platform_fee (or exactly transfer_data.amount).
   * Direct charge on an account: the account bears the processing fee and pays the platform fee.
   */
  private computeSplits(charge: Charge, received: Money, feeMinor: bigint): SettlementSplit[] {
    const total = received.amountMinor;
    const platform = platformOf(charge.ownerId);
    if (charge.transferDestination) {
      const destination = this.accountOwner(charge.ownerId, charge.transferDestination);
      const toDestination = charge.transferAmount ? charge.transferAmount.amountMinor : total - (charge.platformFee?.amountMinor ?? 0n);
      const clamped = toDestination < 0n ? 0n : toDestination > total ? total : toDestination;
      return [
        { ownerId: charge.ownerId, amountMinor: total - clamped - feeMinor },
        { ownerId: destination, amountMinor: clamped },
      ].filter((s) => s.amountMinor !== 0n);
    }
    if (charge.platformFee && !isPlatformOwner(charge.ownerId)) {
      const platformFee = charge.platformFee.amountMinor > total ? total : charge.platformFee.amountMinor;
      return [
        { ownerId: charge.ownerId, amountMinor: total - platformFee - feeMinor },
        { ownerId: platform, amountMinor: platformFee },
      ].filter((s) => s.amountMinor !== 0n);
    }
    return [{ ownerId: charge.ownerId, amountMinor: total - feeMinor }];
  }

  private recordConnectSideEffects(charge: Charge, received: Money): void {
    if (charge.transferDestination) {
      const destinationOwner = this.accountOwner(charge.ownerId, charge.transferDestination);
      // With platform_fee the transfer is recorded at the gross and the platform's cut is a separate fee record.
      const amount = charge.transferAmount ?? received;
      this.transfers.recordFromCharge({ fromOwner: charge.ownerId, toOwner: destinationOwner, amount, chargeId: charge.id });
      if (charge.platformFee && charge.platformFee.amountMinor > 0n) {
        this.transfers.recordPlatformFee({ platformOwner: charge.ownerId, collectedFrom: destinationOwner, chargeId: charge.id, amount: charge.platformFee });
      }
    } else if (charge.platformFee && charge.platformFee.amountMinor > 0n && !isPlatformOwner(charge.ownerId)) {
      this.transfers.recordPlatformFee({ platformOwner: platformOf(charge.ownerId), collectedFrom: charge.ownerId, chargeId: charge.id, amount: charge.platformFee });
    }
  }

  private settle(chargeId: string): void {
    const charge = this.ctx.store.get<Charge>(C.charges, chargeId);
    if (!charge || charge.settlement !== 'pending') return;
    this.moveBucket(charge, 'pending', 'available', `settle charge ${charge.id}`);
    const next = this.save({ ...charge, settlement: 'available' });
    this.ctx.events.publish('charge.settled', next.ownerId, { charge: next });
  }

  private moveBucket(charge: Charge, from: BalanceBucket, to: BalanceBucket, description: string): void {
    const lines: LedgerLine[] = [];
    for (const split of charge.settlementSplits) {
      if (split.amountMinor <= 0n) continue;
      const amount = money(split.amountMinor, charge.amount.currency);
      lines.push({ account: ledgerAccounts.balance(split.ownerId, from), direction: 'debit', amount });
      lines.push({ account: ledgerAccounts.balance(split.ownerId, to), direction: 'credit', amount });
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
