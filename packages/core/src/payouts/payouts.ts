import { ledgerAccounts } from '../ledger/ledger-entry.js';
import type { CurrencyCode } from '../money/currency.js';
import { addMoney, zero, type Money } from '../money/money.js';
import type { FailureReason, ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed, type FieldError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export type DestinationType = 'bank' | 'crypto' | 'mobile_money';

export interface Recipient {
  readonly name: string | null;
  readonly email: string | null;
  readonly address: string | null;
}

export interface PayoutDestination {
  readonly id: string;
  readonly ownerId: string;
  readonly type: DestinationType;
  readonly currency: CurrencyCode;
  readonly country: string | null;
  readonly bankCode: string | null;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  readonly cryptoAddress: string | null;
  readonly network: string | null;
  readonly phone: string | null;
  readonly mobileProvider: string | null;
  readonly recipient: Recipient | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
}

export interface PayoutQuote {
  readonly id: string;
  readonly ownerId: string;
  readonly destinationId: string | null;
  readonly amount: Money;
  readonly fee: Money;
  readonly total: Money;
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
  readonly amount: Money;
  readonly fee: Money;
  readonly status: PayoutStatus;
  readonly failureReason: FailureReason | null;
  readonly plannedOutcome: ScenarioOutcome;
  readonly inReview: boolean;
  readonly reference: string | null;
  readonly description: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly processingAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly updatedAt: string;
}

export type CreateDestinationInput = Omit<PayoutDestination, 'id' | 'createdAt' | 'metadata' | 'country' | 'bankCode' | 'bankName' | 'accountNumber' | 'accountName' | 'cryptoAddress' | 'network' | 'phone' | 'mobileProvider' | 'recipient'> &
  Partial<Pick<PayoutDestination, 'metadata' | 'country' | 'bankCode' | 'bankName' | 'accountNumber' | 'accountName' | 'cryptoAddress' | 'network' | 'phone' | 'mobileProvider' | 'recipient'>>;

export interface CreateQuoteInput {
  readonly ownerId: string;
  readonly amount: Money;
  readonly destinationId?: string | null;
  readonly ttlMs: number;
  readonly fee?: Money;
}

export interface CreatePayoutInput {
  readonly ownerId: string;
  readonly destinationId: string;
  readonly amount?: Money | null;
  readonly quoteId?: string | null;
  readonly reference?: string | null;
  readonly description?: string | null;
  readonly metadata?: Metadata;
  readonly outcomeOverride?: ScenarioOutcome;
}

const PROCESS_JOB = 'payout.process';
const COMPLETE_JOB = 'payout.complete';

export class PayoutsService {
  constructor(private readonly ctx: CoreContext) {
    ctx.scheduler.register<{ payoutId: string }>(PROCESS_JOB, ({ payoutId }) => this.process(payoutId));
    ctx.scheduler.register<{ payoutId: string }>(COMPLETE_JOB, ({ payoutId }) => this.complete(payoutId));
  }

  // Destinations

  createDestination(input: CreateDestinationInput): PayoutDestination {
    const errors: FieldError[] = [];
    if (input.type === 'bank' && (!input.accountNumber || !input.bankCode)) {
      errors.push({ field: 'account_number', message: 'Bank destinations need bank_code and account_number.' });
    }
    if (input.type === 'crypto' && !input.cryptoAddress) errors.push({ field: 'address', message: 'Crypto destinations need an address.' });
    if (input.type === 'mobile_money' && !input.phone) errors.push({ field: 'phone', message: 'Mobile money destinations need a phone number.' });
    if (errors.length) throw validationFailed(errors);
    const destination: PayoutDestination = {
      country: null,
      bankCode: null,
      bankName: null,
      accountNumber: null,
      accountName: null,
      cryptoAddress: null,
      network: null,
      phone: null,
      mobileProvider: null,
      recipient: null,
      metadata: {},
      ...input,
      id: this.ctx.ids.next('dest'),
      createdAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.payoutDestinations, destination);
    return destination;
  }

  getDestination(ownerId: string, id: string): PayoutDestination {
    const destination = this.ctx.store.get<PayoutDestination>(C.payoutDestinations, id);
    if (!destination || destination.ownerId !== ownerId) throw notFound('payout destination', id);
    return destination;
  }

  listDestinations(ownerId: string): PayoutDestination[] {
    return this.ctx.store.list<PayoutDestination>(C.payoutDestinations, (d) => d.ownerId === ownerId).sort(byNewest);
  }

  deleteDestination(ownerId: string, id: string): PayoutDestination {
    const destination = this.getDestination(ownerId, id);
    this.ctx.store.delete(C.payoutDestinations, id);
    return destination;
  }

  // Quotes

  createQuote(input: CreateQuoteInput): PayoutQuote {
    if (input.amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
    if (input.destinationId) this.getDestination(input.ownerId, input.destinationId);
    const now = this.ctx.now();
    const fee = input.fee ?? zero(input.amount.currency);
    const quote: PayoutQuote = {
      id: this.ctx.ids.next('quote'),
      ownerId: input.ownerId,
      destinationId: input.destinationId ?? null,
      amount: input.amount,
      fee,
      total: addMoney(input.amount, fee),
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
      usedAt: null,
      createdAt: now.toISOString(),
    };
    this.ctx.store.put(C.payoutQuotes, quote);
    return quote;
  }

  // Payouts

  create(input: CreatePayoutInput): Payout {
    const destination = this.getDestination(input.ownerId, input.destinationId);
    let amount = input.amount ?? null;
    let fee: Money | null = null;
    let quoteId: string | null = null;

    if (input.quoteId) {
      const quote = this.ctx.store.get<PayoutQuote>(C.payoutQuotes, input.quoteId);
      if (!quote || quote.ownerId !== input.ownerId) throw notFound('payout quote', input.quoteId);
      if (quote.usedAt) throw new SandboxError('invalid_state', `Quote ${quote.id} has already been used.`);
      if (Date.parse(quote.expiresAt) <= this.ctx.now().getTime()) {
        throw new SandboxError('quote_expired', `Quote ${quote.id} expired at ${quote.expiresAt}. Request a new quote.`);
      }
      if (quote.destinationId && quote.destinationId !== destination.id) {
        throw validationFailed([{ field: 'destination_id', message: 'The quote was issued for a different destination.' }]);
      }
      amount = quote.amount;
      fee = quote.fee;
      quoteId = quote.id;
      this.ctx.store.put(C.payoutQuotes, { ...quote, usedAt: this.ctx.nowIso() });
    }
    if (!amount) throw validationFailed([{ field: 'amount', message: 'Provide an amount or a quote.' }]);
    if (amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
    if (amount.currency !== destination.currency) {
      throw validationFailed([{ field: 'currency', message: `The destination receives ${destination.currency}.` }]);
    }
    const payoutFee = fee ?? zero(amount.currency);
    const total = addMoney(amount, payoutFee);
    const available = this.ctx.ledger.bucketBalance(input.ownerId, 'available', amount.currency);
    if (available < total.amountMinor) {
      throw new SandboxError('insufficient_balance', 'Your available balance is too low for this payout.', {
        details: { available: available.toString(), requested: total.amountMinor.toString(), currency: amount.currency },
      });
    }

    const plannedOutcome = this.ctx.scenarios.decide(
      {
        operation: 'payout.create',
        references: [input.reference, destination.id, destination.accountNumber, destination.cryptoAddress],
        ownerId: input.ownerId,
        currency: amount.currency,
      },
      input.outcomeOverride,
    );
    const live = this.ctx.config.fidelity === 'live';
    const now = this.ctx.nowIso();
    const payout: Payout = {
      id: this.ctx.ids.next('po'),
      ownerId: input.ownerId,
      destinationId: destination.id,
      quoteId,
      amount,
      fee: payoutFee,
      status: 'pending',
      failureReason: null,
      plannedOutcome,
      inReview: live && amount.amountMinor >= this.ctx.config.liveReviewThresholdMinor,
      reference: input.reference ?? null,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      processingAt: null,
      completedAt: null,
      failedAt: null,
      updatedAt: now,
    };
    this.ctx.store.put(C.payouts, payout);
    this.ctx.ledger.move(ledgerAccounts.balance(payout.ownerId, 'available'), ledgerAccounts.balance(payout.ownerId, 'reserved'), total, `payout ${payout.id}`, payout.id);
    this.ctx.scheduler.schedule(PROCESS_JOB, this.after(this.ctx.config.payoutProcessingDelayMs), { payoutId: payout.id });
    this.ctx.events.publish('payout.created', payout.ownerId, { payout, destination });
    return payout;
  }

  get(ownerId: string, id: string): Payout {
    const payout = this.ctx.store.get<Payout>(C.payouts, id);
    if (!payout || payout.ownerId !== ownerId) throw notFound('payout', id);
    return payout;
  }

  list(ownerId: string, filter: { readonly status?: PayoutStatus } = {}): Payout[] {
    return this.ctx.store
      .list<Payout>(C.payouts, (p) => p.ownerId === ownerId && (!filter.status || p.status === filter.status))
      .sort(byNewest);
  }

  findDestination(id: string): PayoutDestination | null {
    return this.ctx.store.get<PayoutDestination>(C.payoutDestinations, id) ?? null;
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
    const total = addMoney(payout.amount, payout.fee);
    const destination = this.findDestination(payout.destinationId);
    const now = this.ctx.nowIso();
    if (payout.plannedOutcome.kind === 'fail') {
      const failed = this.save({ ...payout, status: 'failed', failureReason: payout.plannedOutcome.reason, failedAt: now, inReview: false });
      this.ctx.ledger.move(ledgerAccounts.balance(payout.ownerId, 'reserved'), ledgerAccounts.balance(payout.ownerId, 'available'), total, `payout failed ${payout.id}`, payout.id);
      this.ctx.events.publish('payout.failed', failed.ownerId, { payout: failed, destination });
      return;
    }
    const completed = this.save({ ...payout, status: 'completed', completedAt: now, inReview: false });
    this.ctx.ledger.move(ledgerAccounts.balance(payout.ownerId, 'reserved'), ledgerAccounts.external('payout_rail'), total, `payout ${payout.id}`, payout.id);
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
