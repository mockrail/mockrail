import { ledgerAccounts } from '../ledger/ledger-entry.js';
import type { CurrencyCode } from '../money/currency.js';
import { zero, type Money } from '../money/money.js';
import type { FailureReason, ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed, type FieldError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export type DestinationType = 'bank' | 'crypto' | 'mobile_money';
export type DestinationStatus = 'pending_review' | 'approved' | 'rejected';

export interface PayoutDestination {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string | null;
  readonly type: DestinationType;
  /** Currency or asset code as the provider names it (e.g. NGN, USDT_TRC20). */
  readonly currency: string;
  /** Balance currency that funds payouts to this destination. */
  readonly fundingCurrency: CurrencyCode;
  readonly country: string | null;
  readonly bankCode: string | null;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  readonly walletAddress: string | null;
  readonly network: string | null;
  readonly phone: string | null;
  readonly mobileProvider: string | null;
  /** Extra provider-specific routing fields (sort code, IBAN, routing number, ...). */
  readonly details: Readonly<Record<string, unknown>>;
  readonly status: DestinationStatus;
  readonly statusReason: string | null;
  readonly isDefault: boolean;
  readonly reviewedAt: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PayoutQuote {
  readonly id: string;
  readonly ownerId: string;
  readonly fromAmount: Money;
  /** What the destination receives, net of the fee. */
  readonly toAmount: Money;
  readonly exchangeRate: string;
  readonly fee: Money;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly createdAt: string;
}

export type PayoutStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface Payout {
  readonly id: string;
  readonly ownerId: string;
  readonly destinationId: string;
  readonly quoteId: string | null;
  /** Delivered to the destination. */
  readonly amount: Money;
  /** Fee in the funding currency. */
  readonly fee: Money;
  /** Gross debit from the funding balance. */
  readonly totalDebited: Money;
  readonly exchangeRate: string | null;
  readonly status: PayoutStatus;
  readonly failureReason: FailureReason | null;
  readonly plannedOutcome: ScenarioOutcome;
  readonly inReview: boolean;
  readonly reference: string | null;
  readonly narration: string | null;
  /** Rail reference set on completion (e.g. a bank session id). */
  readonly railReference: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly processingAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly updatedAt: string;
}

export interface CreateDestinationInput {
  readonly ownerId: string;
  readonly type: DestinationType;
  readonly currency: string;
  readonly fundingCurrency: CurrencyCode;
  readonly name?: string | null;
  readonly country?: string | null;
  readonly bankCode?: string | null;
  readonly bankName?: string | null;
  readonly accountNumber?: string | null;
  readonly accountName?: string | null;
  readonly walletAddress?: string | null;
  readonly network?: string | null;
  readonly phone?: string | null;
  readonly mobileProvider?: string | null;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly metadata?: Metadata;
  /** Decided by the adapter: approved at once, or waiting for review. */
  readonly status: 'pending_review' | 'approved';
}

export type UpdateDestinationInput = Partial<Omit<CreateDestinationInput, 'ownerId' | 'status'>> & {
  readonly isDefault?: boolean;
  /** Routing changed: re-check as if new. */
  readonly status?: 'pending_review' | 'approved';
};

export interface CreateQuoteInput {
  readonly ownerId: string;
  readonly fromAmount: Money;
  readonly toAmount: Money;
  readonly exchangeRate: string;
  readonly fee: Money;
  readonly ttlMs: number;
}

export interface CreatePayoutInput {
  readonly ownerId: string;
  readonly destinationId: string;
  /** Same-currency payout: amount delivered. Omit when using a quote. */
  readonly amount?: Money | null;
  readonly quoteId?: string | null;
  /** Fee for a same-currency payout, in the funding currency. */
  readonly fee?: Money;
  readonly reference?: string | null;
  readonly narration?: string | null;
  readonly metadata?: Metadata;
  readonly outcomeOverride?: ScenarioOutcome;
}

const PROCESS_JOB = 'payout.process';
const COMPLETE_JOB = 'payout.complete';

function payoutError(reason: string, message: string, code: 'validation_failed' | 'invalid_state' | 'quote_expired' = 'validation_failed'): SandboxError {
  return new SandboxError(code, message, { details: { reason } });
}

export class PayoutsService {
  constructor(private readonly ctx: CoreContext) {
    ctx.scheduler.register<{ payoutId: string }>(PROCESS_JOB, ({ payoutId }) => this.process(payoutId));
    ctx.scheduler.register<{ payoutId: string }>(COMPLETE_JOB, ({ payoutId }) => this.complete(payoutId));
  }

  // Destinations

  createDestination(input: CreateDestinationInput): PayoutDestination {
    const errors: FieldError[] = [];
    if (input.type === 'bank' && !input.accountNumber && !input.details?.iban && !input.details?.interac_email) {
      errors.push({ field: 'account_number', message: 'Bank destinations need an account number.' });
    }
    if (input.type === 'crypto' && !input.walletAddress) errors.push({ field: 'wallet_address', message: 'Crypto destinations need a wallet address.' });
    if (input.type === 'mobile_money' && (!input.phone || !input.mobileProvider)) errors.push({ field: 'phone_number', message: 'Mobile money destinations need phone_number and mobile_provider.' });
    if (errors.length) throw validationFailed(errors);
    const now = this.ctx.nowIso();
    const isFirst = !this.listDestinations(input.ownerId).some((d) => d.currency === input.currency);
    const destination: PayoutDestination = {
      id: this.ctx.ids.entity('payout_destination', input.ownerId),
      ownerId: input.ownerId,
      name: input.name ?? null,
      type: input.type,
      currency: input.currency,
      fundingCurrency: input.fundingCurrency,
      country: input.country ?? null,
      bankCode: input.bankCode ?? null,
      bankName: input.bankName ?? null,
      accountNumber: input.accountNumber ?? null,
      accountName: input.accountName ?? null,
      walletAddress: input.walletAddress ?? null,
      network: input.network ?? null,
      phone: input.phone ?? null,
      mobileProvider: input.mobileProvider ?? null,
      details: input.details ?? {},
      status: input.status,
      statusReason: null,
      isDefault: isFirst && input.status === 'approved',
      reviewedAt: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.payoutDestinations, destination);
    if (destination.status === 'approved') this.ctx.events.publish('payout_destination.approved', destination.ownerId, { destination });
    return destination;
  }

  getDestination(ownerId: string, id: string): PayoutDestination {
    const destination = this.ctx.store.get<PayoutDestination>(C.payoutDestinations, id);
    if (!destination || destination.ownerId !== ownerId) throw notFound('payout destination', id);
    return destination;
  }

  findDestination(id: string): PayoutDestination | null {
    return this.ctx.store.get<PayoutDestination>(C.payoutDestinations, id) ?? null;
  }

  listDestinations(ownerId: string): PayoutDestination[] {
    return this.ctx.store.list<PayoutDestination>(C.payoutDestinations, (d) => d.ownerId === ownerId).sort(byNewest);
  }

  updateDestination(ownerId: string, id: string, patch: UpdateDestinationInput): PayoutDestination {
    const current = this.getDestination(ownerId, id);
    const { isDefault, status, ...fields } = patch;
    let next: PayoutDestination = {
      ...current,
      ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)),
      details: fields.details ? { ...current.details, ...fields.details } : current.details,
      updatedAt: this.ctx.nowIso(),
    };
    if (status && status !== current.status) next = { ...next, status, statusReason: null, reviewedAt: null, isDefault: status === 'approved' ? next.isDefault : false };
    if (isDefault !== undefined && next.status === 'approved') {
      if (isDefault) {
        for (const other of this.listDestinations(ownerId).filter((d) => d.isDefault && d.currency === next.currency && d.id !== id)) {
          this.ctx.store.put(C.payoutDestinations, { ...other, isDefault: false, updatedAt: next.updatedAt });
        }
      }
      next = { ...next, isDefault };
    }
    this.ctx.store.put(C.payoutDestinations, next);
    if (next.status === 'approved' && current.status !== 'approved') this.ctx.events.publish('payout_destination.approved', next.ownerId, { destination: next });
    return next;
  }

  /** Approves or rejects a destination waiting for review (control plane). */
  reviewDestination(id: string, decision: 'approved' | 'rejected', reason?: string | null): PayoutDestination {
    const current = this.findDestination(id);
    if (!current) throw notFound('payout destination', id);
    const now = this.ctx.nowIso();
    const next: PayoutDestination = { ...current, status: decision, statusReason: decision === 'rejected' ? reason ?? 'Rejected in review' : reason ?? null, reviewedAt: now, isDefault: decision === 'rejected' ? false : current.isDefault, updatedAt: now };
    this.ctx.store.put(C.payoutDestinations, next);
    this.ctx.events.publish(decision === 'approved' ? 'payout_destination.approved' : 'payout_destination.rejected', next.ownerId, { destination: next });
    return next;
  }

  deleteDestination(ownerId: string, id: string): PayoutDestination {
    const destination = this.getDestination(ownerId, id);
    this.ctx.store.delete(C.payoutDestinations, id);
    return destination;
  }

  // Quotes

  createQuote(input: CreateQuoteInput): PayoutQuote {
    if (input.fromAmount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
    const now = this.ctx.now();
    const quote: PayoutQuote = {
      id: this.ctx.ids.entity('payout_quote', input.ownerId),
      ownerId: input.ownerId,
      fromAmount: input.fromAmount,
      toAmount: input.toAmount,
      exchangeRate: input.exchangeRate,
      fee: input.fee,
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      usedAt: null,
      createdAt: now.toISOString(),
    };
    this.ctx.store.put(C.payoutQuotes, quote);
    return quote;
  }

  findQuote(id: string): PayoutQuote | null {
    return this.ctx.store.get<PayoutQuote>(C.payoutQuotes, id) ?? null;
  }

  // Payouts

  create(input: CreatePayoutInput): Payout {
    const destination = this.getDestination(input.ownerId, input.destinationId);
    if (destination.status === 'pending_review') throw payoutError('destination_pending_review', 'The payout destination is waiting for review.');
    if (destination.status === 'rejected') throw payoutError('destination_rejected', 'The payout destination was rejected.');
    if (input.reference && this.list(input.ownerId).some((p) => p.reference === input.reference)) {
      throw payoutError('duplicate_reference', 'Reference already exists for this organization');
    }

    let amount: Money;
    let fee: Money;
    let totalDebited: Money;
    let exchangeRate: string | null = null;
    let quoteId: string | null = null;
    if (input.quoteId) {
      const quote = this.findQuote(input.quoteId);
      if (!quote || quote.ownerId !== input.ownerId) throw payoutError('quote_not_found', `No quote found with id '${input.quoteId}'.`);
      if (quote.usedAt) throw payoutError('quote_not_applicable', `Quote ${quote.id} has already been used.`);
      if (Date.parse(quote.expiresAt) <= this.ctx.now().getTime()) throw payoutError('quote_expired', `Quote ${quote.id} expired at ${quote.expiresAt}. Request a new quote.`, 'quote_expired');
      if (quote.toAmount.currency !== destination.fundingCurrency && quote.toAmount.currency !== destination.currency) {
        throw payoutError('quote_destination_mismatch', 'The quote currency does not match the destination.');
      }
      amount = quote.toAmount;
      fee = quote.fee;
      totalDebited = quote.fromAmount;
      exchangeRate = quote.exchangeRate;
      quoteId = quote.id;
      this.ctx.store.put(C.payoutQuotes, { ...quote, usedAt: this.ctx.nowIso() });
    } else {
      if (!input.amount) throw payoutError('amount_required', 'Provide an amount or a quote.');
      if (input.amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
      amount = input.amount;
      fee = input.fee ?? zero(amount.currency);
      totalDebited = { amountMinor: amount.amountMinor + fee.amountMinor, currency: amount.currency };
    }

    const available = this.ctx.ledger.bucketBalance(input.ownerId, 'available', totalDebited.currency);
    if (available < totalDebited.amountMinor) {
      throw new SandboxError('insufficient_balance', 'Insufficient balance for this payout.', {
        details: { available: available.toString(), requested: totalDebited.amountMinor.toString(), currency: totalDebited.currency },
      });
    }

    const plannedOutcome = this.ctx.scenarios.decide(
      {
        operation: 'payout.create',
        references: [input.reference, destination.id, destination.accountNumber, destination.walletAddress],
        ownerId: input.ownerId,
        currency: totalDebited.currency,
      },
      input.outcomeOverride,
    );
    const now = this.ctx.nowIso();
    const payout: Payout = {
      id: this.ctx.ids.entity('payout', input.ownerId),
      ownerId: input.ownerId,
      destinationId: destination.id,
      quoteId,
      amount,
      fee,
      totalDebited,
      exchangeRate,
      status: 'pending',
      failureReason: null,
      plannedOutcome,
      inReview: this.ctx.config.fidelity === 'live' && totalDebited.amountMinor >= this.ctx.config.liveReviewThresholdMinor,
      reference: input.reference ?? null,
      narration: input.narration ?? null,
      railReference: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      processingAt: null,
      completedAt: null,
      failedAt: null,
      updatedAt: now,
    };
    this.ctx.store.put(C.payouts, payout);
    this.ctx.ledger.move(ledgerAccounts.balance(payout.ownerId, 'available'), ledgerAccounts.balance(payout.ownerId, 'reserved'), totalDebited, `payout ${payout.id}`, payout.id);
    this.ctx.scheduler.schedule(PROCESS_JOB, this.after(this.ctx.config.payoutProcessingDelayMs), { payoutId: payout.id });
    this.ctx.events.publish('payout.created', payout.ownerId, { payout, destination });
    return payout;
  }

  get(ownerId: string, id: string): Payout {
    const payout = this.ctx.store.get<Payout>(C.payouts, id);
    if (!payout || payout.ownerId !== ownerId) throw notFound('payout', id);
    return payout;
  }

  list(ownerId: string, filter: { readonly status?: PayoutStatus; readonly reference?: string } = {}): Payout[] {
    return this.ctx.store
      .list<Payout>(C.payouts, (p) => p.ownerId === ownerId && (!filter.status || p.status === filter.status) && (!filter.reference || p.reference === filter.reference))
      .sort(byNewest);
  }

  private process(payoutId: string): void {
    const payout = this.ctx.store.get<Payout>(C.payouts, payoutId);
    if (!payout || payout.status !== 'pending') return;
    const next = this.save({ ...payout, status: 'processing', processingAt: this.ctx.nowIso() });
    const destination = this.findDestination(payout.destinationId);
    let delay = destination?.type === 'mobile_money' ? this.ctx.config.mobileMoneyCompletionDelayMs : this.ctx.config.payoutCompletionDelayMs;
    if (payout.inReview) delay += this.ctx.config.liveReviewDelayMs;
    if (payout.plannedOutcome.kind === 'delay') delay += payout.plannedOutcome.settleAfterMs;
    this.ctx.scheduler.schedule(COMPLETE_JOB, this.after(delay), { payoutId });
    this.ctx.events.publish('payout.processing', next.ownerId, { payout: next, destination });
  }

  private complete(payoutId: string): void {
    const payout = this.ctx.store.get<Payout>(C.payouts, payoutId);
    if (!payout || payout.status !== 'processing') return;
    const destination = this.findDestination(payout.destinationId);
    const now = this.ctx.nowIso();
    if (payout.plannedOutcome.kind === 'fail') {
      const failed = this.save({ ...payout, status: 'failed', failureReason: payout.plannedOutcome.reason, failedAt: now, inReview: false });
      this.ctx.ledger.move(ledgerAccounts.balance(payout.ownerId, 'reserved'), ledgerAccounts.balance(payout.ownerId, 'available'), payout.totalDebited, `payout failed ${payout.id}`, payout.id);
      this.ctx.events.publish('payout.failed', failed.ownerId, { payout: failed, destination });
      return;
    }
    const railReference = destination?.type === 'bank' ? `0000${this.ctx.ids.digits(26)}` : null;
    const completed = this.save({ ...payout, status: 'completed', completedAt: now, inReview: false, railReference });
    this.ctx.ledger.move(ledgerAccounts.balance(payout.ownerId, 'reserved'), ledgerAccounts.external('payout_rail'), payout.totalDebited, `payout ${payout.id}`, payout.id);
    this.ctx.events.publish('payout.completed', completed.ownerId, { payout: completed, destination });
  }

  private after(ms: number): Date {
    return new Date(this.ctx.now().getTime() + ms);
  }

  private save(payout: Payout): Payout {
    const next = { ...payout, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.payouts, next);
    return next;
  }
}
