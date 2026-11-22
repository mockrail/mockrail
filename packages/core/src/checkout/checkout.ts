import type { BillingPolicy } from '../billing/dunning.js';
import { DEFAULT_BILLING_POLICY } from '../billing/dunning.js';
import type { SubscriptionsService } from '../billing/subscriptions.js';
import type { PriceType, ProductsService, Recurring } from '../catalog/products.js';
import type { Charge, ChargesService, FeeRule, PaymentMethod } from '../charges/charges.js';
import type { CustomersService } from '../customers/customers.js';
import { money, type Money } from '../money/money.js';
import type { ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export type CheckoutStatus = 'open' | 'completed' | 'expired';
export type CheckoutMode = 'payment' | 'subscription' | 'setup';

export interface CheckoutLineItem {
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitAmount: Money;
  readonly priceType: PriceType;
  readonly recurring: Recurring | null;
}

export interface CheckoutSession {
  readonly id: string;
  readonly ownerId: string;
  readonly status: CheckoutStatus;
  readonly mode: CheckoutMode;
  /** Empty for ad-hoc pricing. */
  readonly lineItems: readonly CheckoutLineItem[];
  readonly amount: Money;
  readonly customerId: string | null;
  readonly customerEmail: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerCreation: 'always' | 'if_required';
  /** Identity the buyer supplied, once they have. */
  readonly customerDetails: { readonly email: string | null; readonly name: string | null } | null;
  readonly savePaymentMethod: boolean;
  readonly successUrl: string | null;
  readonly cancelUrl: string | null;
  readonly url: string;
  readonly paymentMethodTypes: readonly string[];
  readonly platformFee: Money | null;
  readonly transferDestination: string | null;
  readonly transferAmount: Money | null;
  readonly billingPolicy: BillingPolicy;
  readonly pendingChargeId: string | null;
  /** Details of the in-flight payment needed when it completes (saving the card, renewal fees). */
  readonly pendingPayment: { readonly futureOutcome: ScenarioOutcome | null; readonly feeRule: FeeRule | null } | null;
  readonly chargeId: string | null;
  readonly subscriptionId: string | null;
  readonly paymentMethodId: string | null;
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
  /** Cart of catalog products; or use `amount` for ad-hoc pricing. */
  readonly lineItems?: readonly { readonly productId: string; readonly quantity?: number; readonly amount?: Money | null }[];
  readonly amount?: Money | null;
  readonly customerId?: string | null;
  readonly customerEmail?: string | null;
  readonly customerName?: string | null;
  readonly customerPhone?: string | null;
  readonly customerCreation?: 'always' | 'if_required';
  readonly savePaymentMethod?: boolean;
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
  /** Outcome later charges on the saved method get (cards that save, then decline). */
  readonly futureOutcome?: ScenarioOutcome | null;
  /** Processing fee for the chosen method. */
  readonly feeRule?: FeeRule | null;
}

const EXPIRE_JOB = 'checkout.expire';

function reasonError(reason: string, message: string, field?: string): SandboxError {
  return new SandboxError('validation_failed', message, { details: { reason }, ...(field ? { fieldErrors: [{ field, message }] } : {}) });
}

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
    if (input.customerId) this.customers.get(input.ownerId, input.customerId);
    if (!Number.isFinite(input.expiresInMs) || input.expiresInMs <= 0) throw validationFailed([{ field: 'expires_in_minutes', message: 'Expiry must be positive.' }]);
    if (input.reference && this.list(input.ownerId).some((s) => s.reference === input.reference)) {
      throw reasonError('duplicate_reference', 'A checkout with this reference already exists.', 'reference');
    }

    const lineItems: CheckoutLineItem[] = (input.lineItems ?? []).map((item, i) => {
      const product = this.products.find(item.productId);
      if (!product || product.ownerId !== input.ownerId) throw reasonError('product_not_found', `No product found with id '${item.productId}'.`, `product_cart[${i}].product_id`);
      if (product.archived) throw reasonError('product_archived', `Product ${product.id} is archived.`, `product_cart[${i}].product_id`);
      const quantity = item.quantity ?? 1;
      let unitAmount = product.price;
      if (product.priceType === 'custom') {
        if (!item.amount) throw reasonError('custom_amount_required', `Product ${product.id} needs an amount.`, `product_cart[${i}].amount`);
        unitAmount = item.amount;
      } else if (item.amount && product.priceType === 'fixed') {
        throw reasonError('fixed_amount_override_not_allowed', `Product ${product.id} has a fixed price.`, `product_cart[${i}].amount`);
      }
      return { productId: product.id, productName: product.name, quantity, unitAmount, priceType: product.priceType, recurring: product.recurring };
    });

    if (!lineItems.length && !input.amount) throw validationFailed([{ field: 'pricing', message: 'Provide product_cart or pricing.' }]);
    const currencies = new Set(lineItems.map((l) => l.unitAmount.currency));
    if (currencies.size > 1) throw reasonError('cart_currency_mismatch', 'Every cart item must use the same currency.', 'product_cart');
    const recurringItems = lineItems.filter((l) => l.recurring);
    if (recurringItems.length && (recurringItems.length !== lineItems.length || recurringItems.length > 1)) {
      throw new SandboxError('validation_failed', 'A recurring product cannot be combined with other products.', { status: 422, details: { reason: 'heterogeneous_price_types' } });
    }
    const recurring = recurringItems[0]?.recurring ?? null;

    let amount: Money;
    if (lineItems.length) {
      const currency = lineItems[0]?.unitAmount.currency as Money['currency'];
      amount = money(lineItems.reduce((sum, l) => sum + l.unitAmount.amountMinor * BigInt(l.quantity), 0n), currency);
      // A trial collects nothing up front.
      if (recurring?.trial) amount = money(0n, currency);
    } else {
      amount = input.amount as Money;
    }

    const now = this.ctx.now();
    const id = this.ctx.ids.entity('checkout', input.ownerId);
    const session: CheckoutSession = {
      id,
      ownerId: input.ownerId,
      status: 'open',
      mode: recurring ? 'subscription' : 'payment',
      lineItems,
      amount,
      customerId: input.customerId ?? null,
      customerEmail: input.customerEmail ?? null,
      customerName: input.customerName ?? null,
      customerPhone: input.customerPhone ?? null,
      customerCreation: input.customerCreation ?? 'if_required',
      customerDetails: input.customerEmail || input.customerName ? { email: input.customerEmail ?? null, name: input.customerName ?? null } : null,
      savePaymentMethod: input.savePaymentMethod ?? false,
      successUrl: input.successUrl ?? null,
      cancelUrl: input.cancelUrl ?? null,
      url: `${this.ctx.config.publicBaseUrl}/__sandbox/checkout/${id}`,
      paymentMethodTypes: input.paymentMethodTypes ?? [],
      platformFee: input.platformFee ?? null,
      transferDestination: input.transferDestination ?? null,
      transferAmount: input.transferAmount ?? null,
      billingPolicy: input.billingPolicy ?? DEFAULT_BILLING_POLICY,
      pendingChargeId: null,
      pendingPayment: null,
      chargeId: null,
      subscriptionId: null,
      paymentMethodId: null,
      reference: input.reference ?? null,
      metadata: input.metadata ?? {},
      expiresAt: new Date(now.getTime() + input.expiresInMs).toISOString(),
      completedAt: null,
      expiredAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    if (session.customerId) {
      const customer = this.customers.find(session.customerId);
      Object.assign(session, { customerDetails: { email: customer?.email ?? null, name: customer?.name ?? null } });
    }
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

    const email = input.customerEmail ?? session.customerDetails?.email ?? session.customerEmail;
    const name = input.customerName ?? session.customerDetails?.name ?? session.customerName;
    let customerId = session.customerId;
    const needsRecord = session.mode === 'subscription' || session.savePaymentMethod || session.customerCreation === 'always';
    if (!customerId && needsRecord) {
      if (!email) throw validationFailed([{ field: 'email', message: 'An email is required for this checkout.' }]);
      customerId = this.customers.upsertByEmail({ ownerId: session.ownerId, email, name, phone: session.customerPhone }).customer.id;
    }
    session = this.save({ ...session, customerId, customerDetails: email || name ? { email: email ?? null, name: name ?? null } : session.customerDetails });

    if (session.amount.amountMinor === 0n) {
      const completed = this.complete(session, null, input);
      return { checkout: completed, charge: null };
    }

    const charge = this.charges.createForCheckout({
      ownerId: session.ownerId,
      checkoutId: session.id,
      amount: session.amount,
      customerId: session.customerId,
      paymentMethod: input.paymentMethod,
      feeRule: input.feeRule ?? null,
      platformFee: session.platformFee,
      transferDestination: session.transferDestination,
      transferAmount: session.transferAmount,
      reference: session.reference,
      metadata: session.metadata,
      ...(input.outcomeOverride ? { outcomeOverride: input.outcomeOverride } : {}),
    });
    session = this.save({ ...session, pendingChargeId: charge.id, pendingPayment: { futureOutcome: input.futureOutcome ?? null, feeRule: input.feeRule ?? null } });
    return { checkout: session, charge };
  }

  private onChargeFinalized(charge: Charge): void {
    if (charge.source !== 'checkout' || !charge.checkoutId) return;
    const session = this.find(charge.checkoutId);
    if (!session || session.status !== 'open') return;
    if (charge.status === 'succeeded' || charge.status === 'overpaid') {
      this.complete(session, charge, {
        paymentMethod: charge.paymentMethod ?? { type: 'card', last4: '0000', brand: 'unknown', fingerprint: 'none' },
        futureOutcome: session.pendingPayment?.futureOutcome ?? null,
        feeRule: session.pendingPayment?.feeRule ?? null,
      });
    } else {
      this.save({ ...session, pendingChargeId: null, pendingPayment: null });
    }
  }

  private complete(session: CheckoutSession, charge: Charge | null, input: PayCheckoutInput): CheckoutSession {
    this.ctx.scheduler.cancelByKey(`checkout-expire:${session.id}`);
    let paymentMethodId: string | null = null;
    const method = charge?.paymentMethod ?? input.paymentMethod;
    if (session.customerId && method.type === 'card' && (session.mode === 'subscription' || session.savePaymentMethod)) {
      paymentMethodId = this.customers.savePaymentMethod({
        ownerId: session.ownerId,
        customerId: session.customerId,
        method,
        forcedOutcome: input.futureOutcome ?? null,
        currency: session.amount.currency,
      }).id;
    }
    let completed = this.save({
      ...session,
      status: 'completed',
      pendingChargeId: null,
      pendingPayment: null,
      chargeId: charge?.id ?? null,
      paymentMethodId,
      completedAt: this.ctx.nowIso(),
    });
    const item = session.lineItems.find((l) => l.recurring);
    if (item?.recurring) {
      const subscription = this.subscriptions.createFromCheckout({
        ownerId: session.ownerId,
        customerId: session.customerId,
        productId: item.productId,
        checkoutId: session.id,
        unitAmount: item.unitAmount,
        quantity: item.quantity,
        recurring: item.recurring,
        paymentMethodId,
        policy: session.billingPolicy,
        feeRule: input.feeRule ?? null,
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
