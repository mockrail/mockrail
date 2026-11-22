import type { Recurring } from '../catalog/products.js';
import type { Charge, ChargesService, PaymentMethod } from '../charges/charges.js';
import { DAY } from '../clock/duration.js';
import type { Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { addInterval, nextRetryDelay, type BillingPolicy } from './dunning.js';
import type { Invoice, InvoicesService } from './invoices.js';

export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'unpaid' | 'canceled';
export type CancellationReason = 'payment_failed' | 'requested' | 'canceled_by_merchant';

export interface Subscription {
  readonly id: string;
  readonly ownerId: string;
  readonly customerId: string | null;
  readonly productId: string;
  readonly checkoutId: string | null;
  readonly status: SubscriptionStatus;
  readonly amount: Money;
  readonly recurring: Recurring;
  readonly currentPeriodStart: string;
  readonly currentPeriodEnd: string;
  readonly trialStart: string | null;
  readonly trialEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: string | null;
  readonly cancellationReason: CancellationReason | null;
  readonly latestInvoiceId: string | null;
  readonly paymentMethod: PaymentMethod | null;
  readonly policy: BillingPolicy;
  /** Consecutive failed attempts for the current invoice. */
  readonly failedAttempts: number;
  readonly nextPaymentAttempt: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateSubscriptionInput {
  readonly ownerId: string;
  readonly customerId: string | null;
  readonly productId: string;
  readonly checkoutId: string | null;
  readonly amount: Money;
  readonly recurring: Recurring;
  readonly paymentMethod: PaymentMethod | null;
  readonly policy: BillingPolicy;
  /** The checkout charge that paid the first period (absent for trials). */
  readonly initialCharge: Charge | null;
  readonly metadata?: Metadata;
}

const CYCLE_JOB = 'subscription.cycle';
const RETRY_JOB = 'invoice.retry';

export class SubscriptionsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly charges: ChargesService,
    private readonly invoices: InvoicesService,
  ) {
    ctx.scheduler.register<{ subscriptionId: string }>(CYCLE_JOB, ({ subscriptionId }) => this.cycle(subscriptionId));
    ctx.scheduler.register<{ invoiceId: string }>(RETRY_JOB, ({ invoiceId }) => this.retry(invoiceId));
  }

  /** Subscriptions are created only by completing a checkout for a recurring product. */
  createFromCheckout(input: CreateSubscriptionInput): Subscription {
    const now = this.ctx.now();
    const nowIso = now.toISOString();
    const trialDays = input.recurring.trialDays;
    const trialing = trialDays > 0;
    const periodEnd = trialing ? new Date(now.getTime() + trialDays * DAY) : addInterval(now, input.recurring.interval, input.recurring.intervalCount);
    let subscription: Subscription = {
      id: this.ctx.ids.next('sub'),
      ownerId: input.ownerId,
      customerId: input.customerId,
      productId: input.productId,
      checkoutId: input.checkoutId,
      status: trialing ? 'trialing' : 'active',
      amount: input.amount,
      recurring: input.recurring,
      currentPeriodStart: nowIso,
      currentPeriodEnd: periodEnd.toISOString(),
      trialStart: trialing ? nowIso : null,
      trialEnd: trialing ? periodEnd.toISOString() : null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      cancellationReason: null,
      latestInvoiceId: null,
      paymentMethod: input.paymentMethod,
      policy: input.policy,
      failedAttempts: 0,
      nextPaymentAttempt: null,
      metadata: input.metadata ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.ctx.store.put(C.subscriptions, subscription);

    if (!trialing && input.initialCharge) {
      const invoice = this.invoices.create({
        ownerId: subscription.ownerId,
        subscriptionId: subscription.id,
        customerId: subscription.customerId,
        amount: input.amount,
        billingReason: 'subscription_create',
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      });
      const paid = this.invoices.save({ ...invoice, status: 'paid', attemptCount: 1, chargeId: input.initialCharge.id, paidAt: nowIso });
      subscription = this.save({ ...subscription, latestInvoiceId: paid.id });
      this.ctx.events.publish('subscription.created', subscription.ownerId, { subscription });
      this.ctx.events.publish('invoice.paid', paid.ownerId, { invoice: paid, subscription, charge: input.initialCharge });
    } else {
      this.ctx.events.publish('subscription.created', subscription.ownerId, { subscription });
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

  update(ownerId: string, id: string, patch: { readonly cancelAtPeriodEnd?: boolean; readonly metadata?: Metadata }): Subscription {
    const current = this.get(ownerId, id);
    if (current.status === 'canceled') throw new SandboxError('invalid_state', `Subscription ${id} is canceled.`);
    const next = this.save({
      ...current,
      ...(patch.cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd: patch.cancelAtPeriodEnd } : {}),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
    });
    this.ctx.events.publish('subscription.updated', next.ownerId, { subscription: next, previousStatus: current.status });
    return next;
  }

  cancel(ownerId: string, id: string, reason: CancellationReason = 'canceled_by_merchant'): Subscription {
    const current = this.get(ownerId, id);
    if (current.status === 'canceled') return current;
    return this.markCanceled(current, reason);
  }

  /** Ends a trial now: charges the first period immediately. */
  async endTrial(id: string): Promise<Subscription> {
    const subscription = this.find(id);
    if (!subscription) throw notFound('subscription', id);
    if (subscription.status !== 'trialing') throw new SandboxError('invalid_state', `Subscription ${id} is not trialing.`);
    this.ctx.scheduler.cancelByKey(`sub-cycle:${id}`);
    this.cycle(id, { endTrialAt: this.ctx.now() });
    return this.find(id) ?? subscription;
  }

  // ---------------------------------------------------------------------------

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
    const invoice = this.invoices.create({
      ownerId: subscription.ownerId,
      subscriptionId: subscription.id,
      customerId: subscription.customerId,
      amount: subscription.amount,
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

  private attempt(subscription: Subscription, invoice: Invoice): void {
    const charge = this.charges.chargeInvoice({
      ownerId: subscription.ownerId,
      amount: invoice.amount,
      customerId: subscription.customerId,
      paymentMethod: subscription.paymentMethod ?? { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'sandbox' },
      invoiceId: invoice.id,
      subscriptionId: subscription.id,
    });
    const nowIso = this.ctx.nowIso();
    const attemptCount = invoice.attemptCount + 1;

    if (charge.status === 'succeeded' || charge.status === 'overpaid') {
      const paid = this.invoices.save({ ...invoice, status: 'paid', attemptCount, chargeId: charge.id, paidAt: nowIso, nextPaymentAttempt: null });
      const next = this.save({ ...subscription, status: 'active', failedAttempts: 0, nextPaymentAttempt: null, latestInvoiceId: paid.id });
      this.ctx.events.publish('invoice.paid', paid.ownerId, { invoice: paid, subscription: next, charge });
      this.ctx.events.publish('subscription.updated', next.ownerId, { subscription: next, previousStatus: subscription.status });
      this.scheduleCycle(next);
      return;
    }

    const failures = subscription.failedAttempts + 1;
    const delay = nextRetryDelay(subscription.policy, failures);
    if (delay !== null) {
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

    // Retries exhausted.
    const keepUnpaid = subscription.policy.exhaustedAction === 'unpaid';
    const finalInvoice = this.invoices.save({
      ...invoice,
      status: keepUnpaid ? 'open' : 'uncollectible',
      attemptCount,
      chargeId: charge.id,
      nextPaymentAttempt: null,
    });
    const exhausted = this.save({ ...subscription, failedAttempts: failures, nextPaymentAttempt: null });
    this.ctx.events.publish('invoice.payment_failed', finalInvoice.ownerId, { invoice: finalInvoice, subscription: exhausted, charge });
    if (keepUnpaid) {
      const unpaid = this.save({ ...exhausted, status: 'unpaid' });
      this.ctx.events.publish('subscription.updated', unpaid.ownerId, { subscription: unpaid, previousStatus: subscription.status });
    } else {
      this.markCanceled(exhausted, 'payment_failed');
    }
  }

  private markCanceled(subscription: Subscription, reason: CancellationReason): Subscription {
    this.ctx.scheduler.cancelByKey(`sub-cycle:${subscription.id}`);
    if (subscription.latestInvoiceId) this.ctx.scheduler.cancelByKey(`invoice-retry:${subscription.latestInvoiceId}`);
    const nowIso = this.ctx.nowIso();
    const canceled = this.save({
      ...subscription,
      status: 'canceled',
      canceledAt: nowIso,
      cancellationReason: reason,
      nextPaymentAttempt: null,
    });
    this.ctx.events.publish('subscription.canceled', canceled.ownerId, { subscription: canceled, previousStatus: subscription.status });
    return canceled;
  }

  private scheduleCycle(subscription: Subscription): void {
    this.ctx.scheduler.schedule(CYCLE_JOB, new Date(subscription.currentPeriodEnd), { subscriptionId: subscription.id }, {
      key: `sub-cycle:${subscription.id}`,
    });
  }

  private save(subscription: Subscription): Subscription {
    const next = { ...subscription, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.subscriptions, next);
    return next;
  }
}
