import type { BillingPolicy } from '../billing/dunning.js';
import { DEFAULT_BILLING_POLICY } from '../billing/dunning.js';
import type { SubscriptionsService } from '../billing/subscriptions.js';
import type { ProductsService, Recurring } from '../catalog/products.js';
import type { Charge, ChargesService, PaymentMethod } from '../charges/charges.js';
import type { CustomersService } from '../customers/customers.js';
import { zero, type Money } from '../money/money.js';
import type { ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed, type FieldError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export type CheckoutStatus = 'open' | 'completed' | 'expired';

export interface CheckoutSession {
  readonly id: string;
  readonly ownerId: string;
  readonly status: CheckoutStatus;
  readonly productId: string | null;
  readonly recurring: Recurring | null;
  readonly amount: Money;
  readonly customerId: string | null;
  readonly customerEmail: string | null;
  readonly customerName: string | null;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly url: string;
  readonly paymentMethodTypes: readonly string[];
  readonly platformFee: Money | null;
  readonly transferDestination: string | null;
  readonly transferAmount: Money | null;
  readonly billingPolicy: BillingPolicy;
  readonly pendingChargeId: string | null;
  readonly chargeId: string | null;
  readonly subscriptionId: string | null;
  readonly reference: string | null;
  readonly metadata: Metadata;
  readonly expiresAt: string;
  readonly completedAt: string | null;
  readonly expiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCheckoutInput {
  readonly ownerId: string;
  readonly productId?: string | null;
  readonly amount?: Money | null;
  readonly customerId?: string | null;
  readonly customerEmail?: string | null;
  readonly customerName?: string | null;
  readonly successUrl?: string | null;
  readonly cancelUrl?: string | null;
  readonly expiresInMs: number;
  readonly paymentMethodTypes?: readonly string[];
  readonly platformFee?: Money | null;
  readonly transferDestination?: string | null;
  readonly transferAmount?: Money | null;
  readonly billingPolicy?: BillingPolicy;
  readonly reference?: string | null;
  readonly metadata?: Metadata;
}

export interface PayCheckoutInput {
  readonly paymentMethod: PaymentMethod;
  readonly customerEmail?: string | null;
  readonly customerName?: string | null;
  readonly outcomeOverride?: ScenarioOutcome;
}

const EXPIRE_JOB = 'checkout.expire';

export class CheckoutService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly products: ProductsService,
    private readonly customers: CustomersService,
    private readonly charges: ChargesService,
    private readonly subscriptions: SubscriptionsService,
  ) {
    ctx.scheduler.register<{ checkoutId: string }>(EXPIRE_JOB, ({ checkoutId }) => this.expire(checkoutId));
    charges.onFinalized((charge) => this.onChargeFinalized(charge));
  }

  create(input: CreateCheckoutInput): CheckoutSession {
    const errors: FieldError[] = [];
    const product = input.productId ? this.products.get(input.ownerId, input.productId) : null;
    if (product?.archived) errors.push({ field: 'product_id', message: 'The product is archived.' });
    if (!product && !input.amount) errors.push({ field: 'amount', message: 'Provide a product or an amount.' });
    if (input.customerId) this.customers.get(input.ownerId, input.customerId);
    if (!Number.isFinite(input.expiresInMs) || input.expiresInMs <= 0) errors.push({ field: 'expires_in', message: 'Expiry must be positive.' });
    if (errors.length) throw validationFailed(errors);

    const recurring = product?.recurring ?? null;
    const baseAmount = (product?.price ?? input.amount) as Money;
    // A trial collects nothing up front.
    const amount = recurring && recurring.trialDays > 0 ? zero(baseAmount.currency) : baseAmount;
    const now = this.ctx.now();
    const id = this.ctx.ids.next('cs');
    const session: CheckoutSession = {
      id,
      ownerId: input.ownerId,
      status: 'open',
      productId: product?.id ?? null,
      recurring,
      amount,
      customerId: input.customerId ?? null,
      customerEmail: input.customerEmail ?? null,
      customerName: input.customerName ?? null,
      successUrl: input.successUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
      url: `${this.ctx.config.publicBaseUrl}/__sandbox/checkout/${id}`,
      paymentMethodTypes: input.paymentMethodTypes ?? ['card'],
      platformFee: input.platformFee ?? null,
      transferDestination: input.transferDestination ?? null,
      transferAmount: input.transferAmount ?? null,
      billingPolicy: input.billingPolicy ?? DEFAULT_BILLING_POLICY,
      pendingChargeId: null,
      chargeId: null,
      subscriptionId: null,
      reference: input.reference ?? null,
      metadata: input.metadata ?? {},
      expiresAt: new Date(now.getTime() + input.expiresInMs).toISOString(),
      completedAt: null,
      expiredAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.ctx.store.put(C.checkouts, session);
    this.ctx.scheduler.schedule(EXPIRE_JOB, new Date(session.expiresAt), { checkoutId: id }, { key: `checkout-expire:${id}` });
    this.ctx.events.publish('checkout.created', session.ownerId, { checkout: session });
    return session;
  }

  get(ownerId: string, id: string): CheckoutSession {
    const session = this.find(id);
    if (!session || session.ownerId !== ownerId) throw notFound('checkout session', id);
    return session;
  }

  find(id: string | null | undefined): CheckoutSession | null {
    return id ? this.ctx.store.get<CheckoutSession>(C.checkouts, id) ?? null : null;
  }

  list(ownerId: string): CheckoutSession[] {
    return this.ctx.store.list<CheckoutSession>(C.checkouts, (s) => s.ownerId === ownerId).sort(byNewest);
  }

  /** The customer pays on the (simulated) hosted page. */
  pay(id: string, input: PayCheckoutInput): { checkout: CheckoutSession; charge: Charge | null } {
    let session = this.find(id);
    if (!session) throw notFound('checkout session', id);
    if (session.status === 'open' && Date.parse(session.expiresAt) <= this.ctx.now().getTime()) {
      this.expire(id);
      session = this.find(id) ?? session;
    }
    if (session.status !== 'open') throw new SandboxError('invalid_state', `Checkout session ${id} is ${session.status}.`);
    if (session.pendingChargeId) throw new SandboxError('invalid_state', `A payment for checkout session ${id} is already processing.`);

    const customer = session.customerId
      ? this.customers.find(session.customerId)
      : input.customerEmail || session.customerEmail || input.customerName || session.customerName
        ? this.customers.findOrCreate({
            ownerId: session.ownerId,
            email: input.customerEmail ?? session.customerEmail,
            name: input.customerName ?? session.customerName,
          })
        : null;
    session = this.save({ ...session, customerId: customer?.id ?? null });

    if (session.amount.amountMinor === 0n) {
      const completed = this.complete(session, null, input.paymentMethod);
      return { checkout: completed, charge: null };
    }

    const charge = this.charges.createForCheckout({
      ownerId: session.ownerId,
      checkoutId: session.id,
      amount: session.amount,
      customerId: session.customerId,
      paymentMethod: input.paymentMethod,
      platformFee: session.platformFee,
      transferDestination: session.transferDestination,
      transferAmount: session.transferAmount,
      reference: session.reference,
      metadata: session.metadata,
      ...(input.outcomeOverride ? { outcomeOverride: input.outcomeOverride } : {}),
    });
    session = this.save({ ...session, pendingChargeId: charge.id });
    return { checkout: session, charge };
  }

  private onChargeFinalized(charge: Charge): void {
    if (charge.source !== 'checkout' || !charge.checkoutId) return;
    const session = this.find(charge.checkoutId);
    if (!session || session.status !== 'open') return;
    if (charge.status === 'succeeded' || charge.status === 'overpaid') {
      this.complete(session, charge, charge.paymentMethod);
    } else {
      this.save({ ...session, pendingChargeId: null });
    }
  }

  private complete(session: CheckoutSession, charge: Charge | null, paymentMethod: PaymentMethod | null): CheckoutSession {
    this.ctx.scheduler.cancelByKey(`checkout-expire:${session.id}`);
    let completed = this.save({
      ...session,
      status: 'completed',
      pendingChargeId: null,
      chargeId: charge?.id ?? null,
      completedAt: this.ctx.nowIso(),
    });
    if (session.recurring && session.productId) {
      const product = this.products.get(session.ownerId, session.productId);
      const subscription = this.subscriptions.createFromCheckout({
        ownerId: session.ownerId,
        customerId: session.customerId,
        productId: product.id,
        checkoutId: session.id,
        amount: product.price,
        recurring: session.recurring,
        paymentMethod,
        policy: session.billingPolicy,
        initialCharge: charge,
        metadata: session.metadata,
      });
      completed = this.save({ ...completed, subscriptionId: subscription.id });
    }
    this.ctx.events.publish('checkout.completed', completed.ownerId, { checkout: completed, charge });
    return completed;
  }

  private expire(checkoutId: string): void {
    const session = this.find(checkoutId);
    if (!session || session.status !== 'open') return;
    const expired = this.save({ ...session, status: 'expired', expiredAt: this.ctx.nowIso() });
    this.ctx.events.publish('checkout.expired', expired.ownerId, { checkout: expired });
  }

  private save(session: CheckoutSession): CheckoutSession {
    const next = { ...session, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.checkouts, next);
    return next;
  }
}
