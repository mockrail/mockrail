import type { Recurring } from '../catalog/products.js';
import type { Charge, ChargesService, FeeRule } from '../charges/charges.js';
import type { CustomersService } from '../customers/customers.js';
import { money, type Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { addInterval, nextRetryDelay, type BillingPolicy } from './dunning.js';
import type { Invoice, InvoicesService } from './invoices.js';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled';
export type CancellationReason = 'payment_failed' | 'requested' | 'canceled_by_merchant';
export type ProrationBehavior = 'invoice_now' | 'next_cycle' | 'none';

export interface Subscription {
  readonly id: string;
  readonly ownerId: string;
  readonly customerId: string | null;
  readonly productId: string;
  readonly checkoutId: string | null;
  readonly itemId: string;
  readonly status: SubscriptionStatus;
  readonly unitAmount: Money;
  readonly quantity: number;
  readonly recurring: Recurring;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly trialEnd: string | null;
  readonly previouslyBilledAt: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: string | null;
  readonly cancellationReason: CancellationReason | null;
  readonly cancellationNote: string | null;
  readonly latestInvoiceId: string | null;
  readonly paymentMethodId: string | null;
  readonly policy: BillingPolicy;
  readonly feeRule: FeeRule | null;
  /** Consecutive failed attempts for the current invoice. */
  readonly failedAttempts: number;
  readonly nextPaymentAttempt: string | null;
  /** Carried into the next renewal invoice (proration_behavior next_cycle). */
  readonly pendingAdjustmentMinor: bigint;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSubscriptionInput {
  readonly ownerId: string;
  readonly customerId: string | null;
  readonly productId: string;
  readonly checkoutId: string | null;
  readonly unitAmount: Money;
  readonly quantity: number;
  readonly recurring: Recurring;
  readonly paymentMethodId: string | null;
  readonly policy: BillingPolicy;
  readonly feeRule?: FeeRule | null;
  /** The checkout charge that paid the first period (absent for trials). */
  readonly initialCharge: Charge | null;
  readonly metadata?: Metadata;
}

const CYCLE_JOB = 'subscription.cycle';
const RETRY_JOB = 'invoice.retry';

/** Error with a machine-readable reason adapters can map to their own codes. */
function subError(code: 'invalid_state' | 'validation_failed', reason: string, message: string): SandboxError {
  return new SandboxError(code, message, { details: { reason } });
}

export function subscriptionAmount(s: Pick<Subscription, 'unitAmount' | 'quantity'>): Money {
  return money(s.unitAmount.amountMinor * BigInt(s.quantity), s.unitAmount.currency);
}

/** Next scheduled bill, or null when nothing more will be charged. */
export function nextBilledAt(s: Subscription): string | null {
  if (s.status === 'canceled' || s.status === 'unpaid' || s.cancelAtPeriodEnd) return null;
  return s.currentPeriodEnd;
}

export class SubscriptionsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly charges: ChargesService,
    private readonly invoices: InvoicesService,
    private readonly customers: CustomersService,
  ) {
    ctx.scheduler.register<{ subscriptionId: string }>(CYCLE_JOB, ({ subscriptionId }) => this.cycle(subscriptionId));
    ctx.scheduler.register<{ invoiceId: string }>(RETRY_JOB, ({ invoiceId }) => this.retry(invoiceId));
  }

  /** Subscriptions are created only by completing a checkout for a recurring product. */
  createFromCheckout(input: CreateSubscriptionInput): Subscription {
    const now = this.ctx.now();
    const nowIso = now.toISOString();
    const trial = input.recurring.trial;
    const periodEnd = trial ? addInterval(now, trial.interval, trial.intervalCount) : addInterval(now, input.recurring.interval, input.recurring.intervalCount);
    let subscription: Subscription = {
      id: this.ctx.ids.entity('subscription', input.ownerId),
      ownerId: input.ownerId,
      customerId: input.customerId,
      productId: input.productId,
      checkoutId: input.checkoutId,
      itemId: this.ctx.ids.entity('subscription_item', input.ownerId),
      status: trial ? 'trialing' : 'active',
      unitAmount: input.unitAmount,
      quantity: input.quantity,
      recurring: input.recurring,
      currentPeriodStart: nowIso,
      currentPeriodEnd: periodEnd.toISOString(),
      trialEnd: trial ? periodEnd.toISOString() : null,
      previouslyBilledAt: input.initialCharge ? nowIso : null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      cancellationReason: null,
      cancellationNote: null,
      latestInvoiceId: null,
      paymentMethodId: input.paymentMethodId,
      policy: input.policy,
      feeRule: input.feeRule ?? null,
      failedAttempts: 0,
      nextPaymentAttempt: null,
      pendingAdjustmentMinor: 0n,
      metadata: input.metadata ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.ctx.store.put(C.subscriptions, subscription);
    this.ctx.events.publish('subscription.created', subscription.ownerId, { subscription });

    if (!trial && input.initialCharge) {
      const invoice = this.invoices.create({
        ownerId: subscription.ownerId,
        subscriptionId: subscription.id,
        customerId: subscription.customerId,
        amount: input.initialCharge.amount,
        billingReason: 'subscription_create',
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      });
      const paid = this.invoices.save({ ...invoice, status: 'paid', attemptCount: 1, chargeId: input.initialCharge.id, paidAt: nowIso });
      subscription = this.save({ ...subscription, latestInvoiceId: paid.id });
      this.ctx.events.publish('invoice.paid', paid.ownerId, { invoice: paid, subscription, charge: input.initialCharge });
    }
    this.scheduleCycle(subscription);
    return subscription;
  }

  get(ownerId: string, id: string): Subscription {
    const subscription = this.ctx.store.get<Subscription>(C.subscriptions, id);
    if (!subscription || subscription.ownerId !== ownerId) throw notFound('subscription', id);
    return subscription;
  }

  find(id: string | null | undefined): Subscription | null {
    return id ? this.ctx.store.get<Subscription>(C.subscriptions, id) ?? null : null;
  }

  list(ownerId: string, filter: { readonly status?: SubscriptionStatus; readonly customerId?: string } = {}): Subscription[] {
    return this.ctx.store
      .list<Subscription>(C.subscriptions, (s) => {
        if (s.ownerId !== ownerId) return false;
        if (filter.status && s.status !== filter.status) return false;
        if (filter.customerId && s.customerId !== filter.customerId) return false;
        return true;
      })
      .sort(byNewest);
  }

  updateMetadata(ownerId: string, id: string, metadata: Metadata | null): Subscription {
    const current = this.modifiable(ownerId, id);
    let next: Record<string, string> = {};
    if (metadata) {
      next = { ...current.metadata };
      for (const [k, v] of Object.entries(metadata)) {
        if (v === '') delete next[k];
        else next[k] = v;
      }
    }
    return this.changed(current, { ...current, metadata: next });
  }

  /**
   * A future time adds or extends a trial (an active subscription's trial must end after the paid
   * period). Now or the past ends a trial and bills at once.
   */
  setTrialEnd(ownerId: string, id: string, at: Date): Subscription {
    const current = this.modifiable(ownerId, id);
    const now = this.ctx.now();
    if (at.getTime() <= now.getTime()) {
      if (current.status !== 'trialing') throw subError('invalid_state', 'subscription_not_trialing', `Subscription ${id} is not trialing.`);
      this.ctx.scheduler.cancelByKey(`sub-cycle:${id}`);
      this.cycle(id, { endTrialAt: now });
      return this.find(id) ?? current;
    }
    if (current.status === 'active' && at.getTime() <= Date.parse(current.currentPeriodEnd)) {
      throw subError('validation_failed', 'subscription_trial_ends_in_paid_period', 'The trial must end after the current paid period.');
    }
    if (current.status !== 'active' && current.status !== 'trialing') {
      throw subError('invalid_state', 'subscription_not_modifiable', `Subscription ${id} is ${current.status}.`);
    }
    const next = this.changed(current, { ...current, status: 'trialing', trialEnd: at.toISOString(), currentPeriodEnd: at.toISOString() });
    this.scheduleCycle(next);
    return next;
  }

  /** Swaps the saved payment method; a past_due or unpaid subscription retries at once. */
  setPaymentMethod(ownerId: string, id: string, paymentMethodId: string): Subscription {
    const current = this.modifiable(ownerId, id, { allowUnpaid: true });
    const pm = this.customers.findPaymentMethod(paymentMethodId);
    if (!pm || pm.ownerId !== ownerId || (current.customerId && pm.customerId !== current.customerId)) throw notFound('payment method', paymentMethodId);
    const next = this.changed(current, { ...current, paymentMethodId });
    if ((next.status === 'past_due' || next.status === 'unpaid') && next.latestInvoiceId) {
      const invoice = this.invoices.find(next.latestInvoiceId);
      if (invoice?.status === 'open') {
        this.ctx.scheduler.cancelByKey(`invoice-retry:${invoice.id}`);
        this.attempt(next, invoice, { manual: true });
      }
    }
    return this.find(id) ?? next;
  }

  /** Changes the product (price) and/or quantity, prorating the remainder of the period. */
  changePlan(
    ownerId: string,
    id: string,
    change: { readonly productId?: string; readonly unitAmount?: Money; readonly recurring?: Recurring; readonly quantity?: number; readonly proration: ProrationBehavior },
  ): Subscription {
    const current = this.modifiable(ownerId, id);
    const updated: Subscription = {
      ...current,
      ...(change.productId ? { productId: change.productId } : {}),
      ...(change.unitAmount ? { unitAmount: change.unitAmount } : {}),
      ...(change.recurring ? { recurring: change.recurring } : {}),
      ...(change.quantity !== undefined ? { quantity: change.quantity } : {}),
    };
    if (updated.unitAmount.currency !== current.unitAmount.currency) {
      throw subError('validation_failed', 'plan_not_priced_in_currency', `The new plan is not priced in ${current.unitAmount.currency}.`);
    }
    const before = subscriptionAmount(current).amountMinor;
    const after = subscriptionAmount(updated).amountMinor;
    const start = Date.parse(current.currentPeriodStart);
    const end = Date.parse(current.currentPeriodEnd);
    const remaining = Math.max(0, Math.min(1, (end - this.ctx.now().getTime()) / Math.max(1, end - start)));
    const prorated = current.status === 'trialing' ? 0n : (BigInt(Math.round(remaining * 1_000_000)) * (after - before)) / 1_000_000n;

    const next = this.changed(current, updated);
    if (prorated === 0n || change.proration === 'none') return next;
    if (prorated > 0n && change.proration === 'invoice_now') {
      const invoice = this.invoices.create({
        ownerId,
        subscriptionId: id,
        customerId: next.customerId,
        amount: money(prorated, next.unitAmount.currency),
        billingReason: 'subscription_update',
        kind: 'proration',
        periodStart: this.ctx.nowIso(),
        periodEnd: next.currentPeriodEnd,
      });
      this.attempt(next, invoice, { manual: true, proration: true });
      return this.find(id) ?? next;
    }
    // next_cycle increases, and every decrease (a credit), adjust the next renewal invoice.
    return this.save({ ...next, pendingAdjustmentMinor: next.pendingAdjustmentMinor + prorated });
  }

  cancel(ownerId: string, id: string, options: { readonly atPeriodEnd?: boolean; readonly reason?: string | null } = {}): Subscription {
    const current = this.get(ownerId, id);
    if (current.status === 'canceled') throw subError('invalid_state', 'subscription_already_canceled', `Subscription ${id} is already canceled.`);
    if (options.atPeriodEnd) {
      return this.changed(current, { ...current, cancelAtPeriodEnd: true, cancellationNote: options.reason ?? null });
    }
    return this.markCanceled({ ...current, cancellationNote: options.reason ?? null }, 'canceled_by_merchant');
  }

  /** Ends a trial now (control plane). */
  endTrial(id: string): Subscription {
    const subscription = this.find(id);
    if (!subscription) throw notFound('subscription', id);
    return this.setTrialEnd(subscription.ownerId, id, this.ctx.now());
  }

  // ---------------------------------------------------------------------------

  private modifiable(ownerId: string, id: string, options: { readonly allowUnpaid?: boolean } = {}): Subscription {
    const current = this.get(ownerId, id);
    if (current.status === 'canceled') throw subError('invalid_state', 'subscription_already_canceled', `Subscription ${id} is canceled.`);
    if (current.status === 'unpaid' && !options.allowUnpaid) throw subError('invalid_state', 'subscription_not_modifiable', `Subscription ${id} is unpaid.`);
    return current;
  }

  private cycle(subscriptionId: string, options: { readonly endTrialAt?: Date } = {}): void {
    const subscription = this.find(subscriptionId);
    if (!subscription || subscription.status === 'canceled' || subscription.status === 'unpaid') return;
    if (subscription.cancelAtPeriodEnd) {
      this.markCanceled(subscription, 'requested');
      return;
    }
    const trialEnding = subscription.status === 'trialing';
    const start = options.endTrialAt ?? new Date(subscription.currentPeriodEnd);
    const end = addInterval(start, subscription.recurring.interval, subscription.recurring.intervalCount);
    const base = subscriptionAmount(subscription).amountMinor + subscription.pendingAdjustmentMinor;
    const invoice = this.invoices.create({
      ownerId: subscription.ownerId,
      subscriptionId: subscription.id,
      customerId: subscription.customerId,
      amount: money(base > 0n ? base : 0n, subscription.unitAmount.currency),
      billingReason: trialEnding ? 'trial_end' : 'subscription_cycle',
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
    });
    const updated = this.save({
      ...subscription,
      ...(trialEnding ? { trialEnd: start.toISOString() } : {}),
      currentPeriodStart: invoice.periodStart,
      currentPeriodEnd: invoice.periodEnd,
      latestInvoiceId: invoice.id,
      failedAttempts: 0,
      pendingAdjustmentMinor: 0n,
    });
    this.attempt(updated, invoice);
  }

  private retry(invoiceId: string): void {
    const invoice = this.invoices.find(invoiceId);
    if (!invoice || invoice.status !== 'open') return;
    const subscription = this.find(invoice.subscriptionId);
    if (!subscription || subscription.status !== 'past_due') return;
    this.attempt(subscription, invoice);
  }

  private attempt(subscription: Subscription, invoice: Invoice, options: { readonly manual?: boolean; readonly proration?: boolean } = {}): void {
    const nowIso = this.ctx.nowIso();
    const attemptCount = invoice.attemptCount + 1;
    const pm = this.customers.findPaymentMethod(subscription.paymentMethodId);

    let charge: Charge | null = null;
    if (invoice.amount.amountMinor > 0n) {
      charge = this.charges.chargeInvoice({
        ownerId: subscription.ownerId,
        amount: invoice.amount,
        customerId: subscription.customerId,
        paymentMethod: pm?.method ?? { type: 'card', last4: '0000', brand: 'unknown', fingerprint: 'none' },
        savedPaymentMethodId: pm?.id ?? null,
        feeRule: subscription.feeRule,
        invoiceId: invoice.id,
        subscriptionId: subscription.id,
        ...(pm ? (pm.forcedOutcome ? { outcomeOverride: pm.forcedOutcome } : {}) : { outcomeOverride: { kind: 'fail', reason: 'declined' } }),
      });
    }

    if (!charge || charge.status === 'succeeded' || charge.status === 'overpaid') {
      const paid = this.invoices.save({ ...invoice, status: 'paid', attemptCount, chargeId: charge?.id ?? null, paidAt: nowIso, nextPaymentAttempt: null });
      const next = this.save({
        ...subscription,
        status: options.proration ? subscription.status : 'active',
        failedAttempts: 0,
        nextPaymentAttempt: null,
        previouslyBilledAt: nowIso,
        latestInvoiceId: options.proration ? subscription.latestInvoiceId : paid.id,
      });
      this.ctx.events.publish('invoice.paid', paid.ownerId, { invoice: paid, subscription: next, charge });
      if (next.status !== subscription.status) {
        this.ctx.events.publish('subscription.updated', next.ownerId, { subscription: next, previousStatus: subscription.status });
      }
      if (!options.proration) this.scheduleCycle(next);
      return;
    }

    if (options.proration) {
      this.invoices.save({ ...invoice, status: 'void', attemptCount, chargeId: charge.id });
      this.ctx.events.publish('invoice.payment_failed', invoice.ownerId, { invoice: { ...invoice, attemptCount, chargeId: charge.id }, subscription, charge });
      return;
    }

    const failures = options.manual ? subscription.failedAttempts : subscription.failedAttempts + 1;
    const delay = nextRetryDelay(subscription.policy, failures);
    if (subscription.status !== 'unpaid' && delay !== null) {
      const nextAttempt = new Date(this.ctx.now().getTime() + delay).toISOString();
      const failed = this.invoices.save({ ...invoice, attemptCount, chargeId: charge.id, nextPaymentAttempt: nextAttempt });
      const next = this.save({ ...subscription, status: 'past_due', failedAttempts: failures, nextPaymentAttempt: nextAttempt });
      this.ctx.scheduler.schedule(RETRY_JOB, new Date(nextAttempt), { invoiceId: invoice.id }, { key: `invoice-retry:${invoice.id}` });
      this.ctx.events.publish('invoice.payment_failed', failed.ownerId, { invoice: failed, subscription: next, charge });
      if (subscription.status !== 'past_due') {
        this.ctx.events.publish('subscription.updated', next.ownerId, { subscription: next, previousStatus: subscription.status });
      }
      return;
    }
    if (subscription.status === 'unpaid') {
      const failed = this.invoices.save({ ...invoice, attemptCount, chargeId: charge.id });
      this.ctx.events.publish('invoice.payment_failed', failed.ownerId, { invoice: failed, subscription, charge });
      return;
    }

    // Retries exhausted.
    const keepUnpaid = subscription.policy.exhaustedAction === 'unpaid';
    const finalInvoice = this.invoices.save({ ...invoice, status: keepUnpaid ? 'open' : 'uncollectible', attemptCount, chargeId: charge.id, nextPaymentAttempt: null });
    const exhausted = this.save({ ...subscription, failedAttempts: failures, nextPaymentAttempt: null });
    this.ctx.events.publish('invoice.payment_failed', finalInvoice.ownerId, { invoice: finalInvoice, subscription: exhausted, charge });
    if (keepUnpaid) {
      const unpaid = this.save({ ...exhausted, status: 'unpaid' });
      this.ctx.events.publish('subscription.updated', unpaid.ownerId, { subscription: unpaid, previousStatus: subscription.status });
    } else {
      this.markCanceled(exhausted, 'payment_failed');
    }
  }

  private changed(previous: Subscription, next: Subscription): Subscription {
    const saved = this.save(next);
    this.ctx.events.publish('subscription.updated', saved.ownerId, { subscription: saved, previousStatus: previous.status });
    return saved;
  }

  private markCanceled(subscription: Subscription, reason: CancellationReason): Subscription {
    this.ctx.scheduler.cancelByKey(`sub-cycle:${subscription.id}`);
    if (subscription.latestInvoiceId) this.ctx.scheduler.cancelByKey(`invoice-retry:${subscription.latestInvoiceId}`);
    const canceled = this.save({ ...subscription, status: 'canceled', canceledAt: this.ctx.nowIso(), cancellationReason: reason, nextPaymentAttempt: null });
    this.ctx.events.publish('subscription.canceled', canceled.ownerId, { subscription: canceled, previousStatus: subscription.status });
    return canceled;
  }

  private scheduleCycle(subscription: Subscription): void {
    this.ctx.scheduler.schedule(CYCLE_JOB, new Date(subscription.currentPeriodEnd), { subscriptionId: subscription.id }, { key: `sub-cycle:${subscription.id}` });
  }

  private save(subscription: Subscription): Subscription {
    const next = { ...subscription, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.subscriptions, next);
    return next;
  }
}
