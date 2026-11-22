import {
  isPlatformOwner,
  localOf,
  nextBilledAt,
  subscriptionAmount,
  type AccountDocument,
  type AccountLink,
  type Address,
  type Charge,
  type CheckoutSession,
  type ConnectedAccount,
  type Customer,
  type Invoice,
  type Money,
  type OwnerBalance,
  type Payout,
  type PayoutDestination,
  type PayoutQuote,
  type Person,
  type PlatformFee,
  type Product,
  type ProviderWebhookEventRecord,
  type Refund,
  type Sandbox,
  type SavedPaymentMethod,
  type Subscription,
  type Transfer,
  type VirtualAccount,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '@mockrail/core';
import { BACHS } from './constants.js';
import { convert, formatAmount, formatAmountOrNull } from './money.js';
import type { ResolvedBachsOptions } from './options.js';

/** Everything a serializer may need to look up related records. */
export interface View {
  readonly sandbox: Sandbox;
  readonly options: ResolvedBachsOptions;
}

/** Bachs account id for an owner: the platform's own id, or the connected account id. */
export function accountIdOf(view: View, owner: string): string {
  return isPlatformOwner(owner) ? view.options.organizationId : localOf(owner);
}

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  declined: 'Card declined',
  insufficient_funds: 'Insufficient funds',
  expired_card: 'Expired card',
  processing_error: 'Processing error',
  account_name_mismatch: 'Account name does not match',
  bank_rejected: 'Rejected by the receiving bank',
  invalid_destination: 'Invalid destination',
  review_rejected: 'Rejected in review',
  unknown: 'Payment failed',
};

export function failureMessage(reason: string | null): string | null {
  return reason ? (FAILURE_MESSAGES[reason] ?? 'Payment failed') : null;
}

// ---------------------------------------------------------------------------
// Customers

export function serializeAddress(a: Address | null) {
  return a ? { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postalCode, country: a.country } : null;
}

export function serializeCustomer(c: Customer) {
  return {
    customer_id: c.id,
    email: c.email,
    name: c.name,
    phone_number: c.phone,
    metadata: c.metadata,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    billing_address: serializeAddress(c.billingAddress),
  };
}

export function serializeCustomerListItem(c: Customer) {
  return { customer_id: c.id, email: c.email, name: c.name, metadata: c.metadata, created_at: c.createdAt };
}

// ---------------------------------------------------------------------------
// Products

function cadence(c: { interval: string; intervalCount: number } | null | undefined) {
  return c ? { interval: c.interval, frequency: c.intervalCount } : null;
}

export function serializeProduct(view: View, p: Product) {
  const paid = view.sandbox.charges
    .list(p.ownerId)
    .filter((c) => (c.status === 'succeeded' || c.status === 'overpaid') && view.sandbox.checkout.find(c.checkoutId)?.lineItems.some((l) => l.productId === p.id));
  const totalMinor = paid.filter((c) => c.amount.currency === p.price.currency).reduce((sum, c) => sum + c.amountReceived.amountMinor, 0n);
  const fixed = p.priceType === 'fixed';
  return {
    id: p.id,
    organization_id: accountIdOf(view, p.ownerId),
    name: p.name,
    description: p.description,
    price: {
      currency: p.price.currency,
      price_type: p.priceType,
      amount: fixed ? formatAmount(p.price) : null,
      preset_amount: formatAmountOrNull(p.customBounds?.preset),
      minimum_amount: formatAmountOrNull(p.customBounds?.minimum),
      maximum_amount: formatAmountOrNull(p.customBounds?.maximum),
      currency_options: p.currencyOptions.map((o) => ({ currency: o.currency, amount: formatAmount(o), minimum_amount: null, maximum_amount: null })),
    },
    status: p.archived ? 'archived' : 'active',
    metadata: p.metadata,
    media: [],
    actor_id: 'usr_sandbox',
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    archived_at: p.archivedAt,
    billing_cycle: cadence(p.recurring),
    trial_period: cadence(p.recurring?.trial),
    prices: [p.price, ...p.currencyOptions].map((m, i) => ({
      currency: m.currency,
      amount: fixed ? formatAmount(m) : null,
      minimum_amount: i === 0 ? formatAmountOrNull(p.customBounds?.minimum) : null,
      maximum_amount: i === 0 ? formatAmountOrNull(p.customBounds?.maximum) : null,
      is_default: i === 0,
    })),
    total_payments: paid.length,
    total_amount: formatAmount({ amountMinor: totalMinor, currency: p.price.currency }),
  };
}

// ---------------------------------------------------------------------------
// Payments

/** Payment status enum on PaymentResponse (the API reference, which differs from the statuses guide). */
export function paymentStatus(view: View, c: Charge): string {
  switch (c.status) {
    case 'pending':
      return 'processing';
    case 'failed':
      return 'failed';
    case 'underpaid':
      return 'underpaid';
    case 'succeeded':
    case 'overpaid': {
      const refunded = refundedMinor(view, c);
      if (refunded > 0n && refunded >= c.amountReceived.amountMinor) return 'refunded';
      if (refunded > 0n) return 'partially_refunded';
      return c.status;
    }
  }
}

function refundedMinor(view: View, c: Charge): bigint {
  return view.sandbox.refunds
    .list(c.ownerId, { chargeId: c.id })
    .filter((r) => r.status === 'succeeded')
    .reduce((sum, r) => sum + r.amount.amountMinor, 0n);
}

/** Payment method string on a single payment (CARD, NGN_BANK_TRANSFER, MOMO_GHS, CRYPTO). */
export function paymentMethodCode(c: Charge): string | null {
  const m = c.paymentMethod;
  if (!m) return null;
  switch (m.type) {
    case 'card':
      return 'CARD';
    case 'bank_transfer':
      return c.amount.currency === 'NGN' ? 'NGN_BANK_TRANSFER' : 'BANK_TRANSFER';
    case 'mobile_money':
      return `MOMO_${c.amount.currency}`;
    case 'crypto':
      return 'CRYPTO';
  }
}

/** Lowercase payment method type on list items and the payments filter (e.g. ngn_bank_transfer). */
export function paymentMethodType(c: Charge): string | null {
  const m = c.paymentMethod;
  if (!m) return null;
  if (m.type === 'bank_transfer') return c.amount.currency === 'NGN' ? 'ngn_bank_transfer' : 'bank_transfer';
  return m.type;
}

export function isRefundable(view: View, c: Charge): boolean {
  if (!['succeeded', 'overpaid', 'underpaid'].includes(c.status)) return false;
  if (c.paymentMethod?.type === 'bank_transfer' && view.sandbox.config.fidelity === 'live') return false;
  return !view.sandbox.refunds.list(c.ownerId, { chargeId: c.id }).some((r) => r.status !== 'failed');
}

function billingReason(view: View, c: Charge): string {
  const invoice = view.sandbox.invoices.find(c.invoiceId);
  if (!invoice) return 'purchase';
  return invoice.billingReason === 'trial_end' ? 'subscription_cycle' : invoice.billingReason;
}

function channel(c: Charge): string {
  return { api: 'api', checkout: 'checkout', invoice: 'subscription', deposit: 'virtual_account' }[c.source];
}

export function paymentMethodDetails(view: View, c: Charge): Record<string, unknown> | null {
  const m = c.paymentMethod;
  if (!m) return null;
  if (m.type === 'card') {
    return { type: 'card', card: { brand: m.brand, last4: m.last4, exp_month: m.expMonth ?? 12, exp_year: m.expYear ?? 2030, cardholder_name: null, fingerprint: m.fingerprint } };
  }
  if (m.type === 'bank_transfer') {
    const va = view.sandbox.virtualAccounts.findById(c.virtualAccountId);
    return {
      type: 'bank_transfer',
      bank_transfer: {
        sender_name: m.senderName,
        sender_bank: m.senderBankName,
        sender_bank_code: m.senderBankCode ?? null,
        sender_account_number: m.senderAccountNumber,
        session_id: m.sessionId ?? null,
        narration: m.narration ?? null,
        virtual_account: va ? { id: va.id, account_number: va.accountNumber, bank_name: va.bankName, type: 'permanent', expires_at: null } : null,
      },
    };
  }
  return { type: m.type };
}

function apiHistoryStatus(status: string): string {
  return status === 'pending' ? 'processing' : status;
}

function feeUsd(fee: Money | null): string | null {
  return fee ? formatAmount(convert(fee, 'USD')) : null;
}

/** PaymentResponse, shared by GET /v1/payments/{id}, POST /v1/charges and checkout.charge. */
export function serializePayment(view: View, c: Charge) {
  const customer = view.sandbox.customers.find(c.customerId);
  const checkout = view.sandbox.checkout.find(c.checkoutId);
  const invoice = view.sandbox.invoices.find(c.invoiceId);
  const remaining = c.status === 'pending' || c.status === 'failed' ? c.amount.amountMinor : c.amount.amountMinor - c.amountReceived.amountMinor;
  return {
    reference: c.reference,
    payment_id: c.id,
    billing_reason: billingReason(view, c),
    checkout_id: c.checkoutId,
    status: paymentStatus(view, c),
    failure_message: c.status === 'failed' ? failureMessage(c.failureReason) : null,
    is_refundable: isRefundable(view, c),
    amount: formatAmount(c.amount),
    amount_paid: formatAmount(c.amountReceived),
    amount_remaining: formatAmount({ amountMinor: remaining > 0n ? remaining : 0n, currency: c.amount.currency }),
    currency: c.amount.currency,
    fee_usd: feeUsd(c.processingFee),
    fees: c.processingFee ? { amount: formatAmount(c.processingFee), currency: c.processingFee.currency } : null,
    merchant_bears_cost: true,
    platform_fee: formatAmountOrNull(c.platformFee),
    destination_amount: c.transferDestination ? formatAmount(c.transferAmount ?? { amountMinor: c.amount.amountMinor - (c.platformFee?.amountMinor ?? 0n), currency: c.amount.currency }) : null,
    fee_paid_by: 'merchant',
    payment_method: paymentMethodCode(c),
    channel: channel(c),
    narration: c.description,
    meta: c.metadata,
    message: c.status === 'failed' ? failureMessage(c.failureReason) : c.status === 'pending' ? 'Processing' : 'Successful',
    customer: customer ? { name: customer.name, email: customer.email } : checkout?.customerDetails ? { name: checkout.customerDetails.name, email: checkout.customerDetails.email } : null,
    line_items: checkout?.lineItems.length
      ? checkout.lineItems.map((l) => ({
          product_id: l.productId,
          product_name: l.productName,
          quantity: l.quantity,
          unit_amount: formatAmount(l.unitAmount),
          currency: l.unitAmount.currency,
          line_total: formatAmount({ amountMinor: l.unitAmount.amountMinor * BigInt(l.quantity), currency: l.unitAmount.currency }),
        }))
      : null,
    subscription_id: c.subscriptionId,
    invoice: invoice ? { invoice_id: invoice.id, number: null, subscription_id: invoice.subscriptionId, period_start: invoice.periodStart, period_end: invoice.periodEnd, kind: invoice.kind } : null,
    refunds: view.sandbox.refunds.list(c.ownerId, { chargeId: c.id }).map((r) => r.id),
    status_history: c.statusHistory.map((h) => ({ status: apiHistoryStatus(h.status), occurred_at: h.occurredAt, reason: h.reason })),
    payment_method_details: paymentMethodDetails(view, c),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    completed_at: c.status === 'pending' ? null : c.finalizedAt,
  };
}

export function serializePaymentListItem(view: View, c: Charge) {
  const customer = view.sandbox.customers.find(c.customerId);
  const checkout = view.sandbox.checkout.find(c.checkoutId);
  const m = c.paymentMethod;
  return {
    reference: c.reference,
    id: c.id,
    status: paymentStatus(view, c),
    failure_message: c.status === 'failed' ? failureMessage(c.failureReason) : null,
    is_refundable: isRefundable(view, c),
    amount: formatAmount(c.amount),
    customer_name: customer?.name ?? checkout?.customerDetails?.name ?? '',
    customer_email: customer?.email ?? checkout?.customerDetails?.email ?? '',
    amount_paid: formatAmount(c.amountReceived),
    amount_remaining: formatAmount({ amountMinor: c.status === 'pending' || c.status === 'failed' ? c.amount.amountMinor : 0n, currency: c.amount.currency }),
    settlement_amount: c.processingFee ? formatAmount({ amountMinor: c.amountReceived.amountMinor - c.processingFee.amountMinor, currency: c.amount.currency }) : null,
    settlement_currency: c.status === 'pending' ? null : c.amount.currency,
    fee: formatAmountOrNull(c.processingFee),
    vat: null,
    currency: c.amount.currency,
    meta: c.metadata,
    transaction_date: c.createdAt,
    completed_at: c.status === 'pending' ? null : c.finalizedAt,
    platform_fee: formatAmountOrNull(c.platformFee),
    destination_amount: null,
    payment_method: m ? { type: paymentMethodType(c), brand: m.type === 'card' ? m.brand : null, last4: m.type === 'card' ? m.last4 : null } : null,
    source: { type: c.source === 'checkout' ? 'CHECKOUT_SESSION' : c.source === 'deposit' ? 'VIRTUAL_ACCOUNT' : 'API', checkout_id: c.checkoutId, reference: c.reference },
    description: c.description,
    fee_paid_by: 'merchant',
  };
}

// ---------------------------------------------------------------------------
// Checkout

export function checkoutPaymentStatus(view: View, s: CheckoutSession): string | null {
  if (s.status === 'expired') return null;
  if (s.status === 'completed') return s.chargeId ? 'succeeded' : null;
  const pending = view.sandbox.charges.find(s.pendingChargeId);
  if (pending) return 'processing';
  const last = view.sandbox.charges.list(s.ownerId, { checkoutId: s.id })[0];
  return last?.status === 'failed' ? 'failed' : 'requires_payment_method';
}

export function serializeCheckoutCreated(s: CheckoutSession) {
  return {
    checkout_id: s.id,
    checkout_url: s.url,
    status: s.status,
    expires_at: s.expiresAt,
    created_at: s.createdAt,
    reference: s.reference,
    platform_fee: formatAmountOrNull(s.platformFee),
    destination_amount: formatAmountOrNull(s.transferAmount),
  };
}

export function serializeCheckout(view: View, s: CheckoutSession) {
  const customer = view.sandbox.customers.find(s.customerId);
  const charge = view.sandbox.charges.find(s.chargeId);
  const recurringItem = s.lineItems.find((l) => l.recurring);
  return {
    checkout_id: s.id,
    status: s.status,
    recurring: recurringItem?.recurring ? { interval: recurringItem.recurring.interval, interval_count: recurringItem.recurring.intervalCount } : null,
    payment_status: checkoutPaymentStatus(view, s),
    source_type: 'CHECKOUT_SESSION',
    amount: formatAmount(s.amount),
    currency: s.amount.currency,
    reference: s.reference,
    charge: charge ? serializePayment(view, charge) : null,
    payment_method: charge ? paymentMethodCode(charge) : null,
    customer: { id: customer?.id ?? null, email: customer?.email ?? s.customerDetails?.email ?? null, name: customer?.name ?? s.customerDetails?.name ?? null },
    customer_details: s.customerDetails ? { email: s.customerDetails.email, name: s.customerDetails.name } : null,
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    products: s.lineItems.length
      ? s.lineItems.map((l) => ({
          product_id: l.productId,
          product_name: l.productName,
          quantity: l.quantity,
          unit_amount: formatAmount(l.unitAmount),
          currency: l.unitAmount.currency,
          price_type: l.priceType,
          line_total: formatAmount({ amountMinor: l.unitAmount.amountMinor * BigInt(l.quantity), currency: l.unitAmount.currency }),
          minimum_amount: null,
          maximum_amount: null,
        }))
      : null,
    billing_currency: s.amount.currency,
    platform_fee: formatAmountOrNull(s.platformFee),
    destination_amount: formatAmountOrNull(s.transferAmount),
    session_mode: s.lineItems.length ? 'CART' : null,
    metadata: s.metadata,
    created_at: s.createdAt,
    expires_at: s.expiresAt,
    completed_at: s.completedAt,
    updated_at: s.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Subscriptions and invoices

export function serializeSubscription(view: View, s: Subscription) {
  const customer = view.sandbox.customers.find(s.customerId);
  const product = view.sandbox.products.find(s.productId);
  const amount = subscriptionAmount(s);
  return {
    id: s.id,
    customer: customer ? serializeCustomer(customer) : null,
    payment_method_id: s.paymentMethodId,
    status: s.status,
    collection_method: 'charge_automatically',
    currency: s.unitAmount.currency,
    amount: formatAmount(amount),
    billing_cycle: cadence(s.recurring),
    quantity: s.quantity,
    seats: s.quantity,
    current_period_start: s.currentPeriodStart,
    current_period_end: s.currentPeriodEnd,
    previously_billed_at: s.previouslyBilledAt,
    next_billed_at: nextBilledAt(s),
    trial_end: s.status === 'trialing' ? s.trialEnd : null,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt,
    created_at: s.createdAt,
    product: product
      ? {
          id: product.id,
          name: product.name,
          description: product.description,
          status: product.archived ? 'archived' : 'active',
          billing_cycle: cadence(product.recurring),
          trial_period: cadence(product.recurring?.trial),
          created_at: product.createdAt,
          updated_at: product.updatedAt,
        }
      : null,
    items: [
      {
        id: s.itemId,
        status: s.status,
        quantity: s.quantity,
        seats: s.quantity,
        recurring: true,
        price_type: product?.priceType ?? 'fixed',
        unit_amount: formatAmount(s.unitAmount),
        currency: s.unitAmount.currency,
        previously_billed_at: s.previouslyBilledAt,
        next_billed_at: nextBilledAt(s),
        price: null,
        product: null,
        created_at: s.createdAt,
        updated_at: s.updatedAt,
      },
    ],
    metadata: s.metadata,
  };
}

/** The `charge` object inside checkout.completed and invoice events. */
export function serializeEventCharge(view: View, c: Charge) {
  return {
    id: c.id,
    organization_id: accountIdOf(view, c.ownerId),
    customer_id: c.customerId,
    amount: formatAmount(c.amount),
    currency: c.amount.currency,
    settlement_currency: c.status === 'pending' ? null : c.amount.currency,
    settlement_amount: c.status === 'pending' ? null : formatAmount({ amountMinor: c.amountReceived.amountMinor - (c.processingFee?.amountMinor ?? 0n), currency: c.amount.currency }),
    status: paymentStatus(view, c),
    metadata: c.metadata,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export function serializeInvoice(view: View, i: Invoice, charge: Charge | null) {
  const customer = view.sandbox.customers.find(i.customerId);
  const paid = i.status === 'paid';
  return {
    invoice_id: i.id,
    subscription: { subscription_id: i.subscriptionId },
    customer: customer ? { customer_id: customer.id, email: customer.email, name: customer.name } : null,
    charge: charge ? serializeEventCharge(view, charge) : null,
    status: i.status,
    collection_method: 'charge_automatically',
    currency: i.amount.currency,
    subtotal: formatAmount(i.amount),
    total: formatAmount(i.amount),
    amount_paid: formatAmount(paid ? i.amount : { amountMinor: 0n, currency: i.amount.currency }),
    amount_remaining: formatAmount(paid ? { amountMinor: 0n, currency: i.amount.currency } : i.amount),
    period_start: i.periodStart,
    period_end: i.periodEnd,
    attempt_count: i.attemptCount,
    next_payment_attempt: i.nextPaymentAttempt,
    created_at: i.createdAt,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Virtual accounts, refunds, balances

export function serializeVirtualAccount(v: VirtualAccount) {
  return {
    id: v.id,
    currency: v.currency,
    account_number: v.accountNumber,
    account_name: v.accountName,
    bank_name: v.bankName,
    bank_code: v.bankCode,
    status: v.status,
    created_at: v.createdAt,
  };
}

/** Refund object (API): status processing | success | failed; fee_bearer org | customer. */
export function serializeRefund(r: Refund) {
  return {
    refund_id: r.id,
    charge_id: r.chargeId,
    reference: r.reference,
    status: r.status === 'pending' ? 'processing' : r.status === 'succeeded' ? 'success' : 'failed',
    requested_amount: formatAmount(r.amount),
    refunded_amount: r.status === 'succeeded' ? formatAmount(r.amount) : null,
    refund_fee_amount: formatAmount(r.fee),
    fee_bearer: r.feeBearer === 'merchant' ? 'org' : 'customer',
    reason: r.reason,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    completed_at: r.completedAt,
  };
}

export function serializeBalances(view: View, owner: string, balances: readonly OwnerBalance[]) {
  const totalUsdMinor = balances.reduce((sum, b) => sum + convert({ amountMinor: b.available + b.pending, currency: b.currency }, 'USD').amountMinor, 0n);
  return {
    account_id: accountIdOf(view, owner),
    balances: balances.map((b) => ({
      currency: b.currency,
      available_balance: formatAmount({ amountMinor: b.available, currency: b.currency }),
      pending_balance: formatAmount({ amountMinor: b.pending, currency: b.currency }),
    })),
    total_balance_usd: formatAmount({ amountMinor: totalUsdMinor, currency: 'USD' }),
    pending_settlements_by_day: [],
  };
}

// ---------------------------------------------------------------------------
// Payouts

const DESTINATION_TYPE: Readonly<Record<PayoutDestination['type'], string>> = { bank: 'bank_account', mobile_money: 'mobile_money', crypto: 'crypto_wallet' };

export function destinationType(d: PayoutDestination): string {
  return DESTINATION_TYPE[d.type];
}

export function serializeDestination(d: PayoutDestination) {
  const x = d.details as Record<string, unknown>;
  const s = (k: string): unknown => x[k] ?? null;
  return {
    id: d.id,
    name: d.name ?? d.accountName ?? d.walletAddress ?? d.phone ?? d.id,
    type: destinationType(d),
    currency: d.currency,
    status: d.status,
    status_reason: d.statusReason,
    is_usable: d.status === 'approved',
    is_default: d.isDefault,
    account_number: d.accountNumber,
    account_name: d.accountName,
    bank_code: d.bankCode,
    bank_name: d.bankName,
    phone_number: d.phone,
    mobile_provider: d.mobileProvider,
    wallet_address: d.walletAddress,
    network: d.network,
    reviewed_at: d.reviewedAt,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    sort_code: s('sort_code'),
    iban: s('iban'),
    swift_bic: s('swift_bic'),
    routing_number: s('routing_number'),
    bank_address: s('bank_address'),
    institution_number: s('institution_number'),
    transit_number: s('transit_number'),
    interac_email: s('interac_email'),
    scheme: s('scheme'),
  };
}

export function serializeQuote(q: PayoutQuote) {
  return {
    quote_id: q.id,
    from_currency: q.fromAmount.currency,
    to_currency: q.toAmount.currency,
    from_amount: formatAmount(q.fromAmount),
    to_amount: formatAmount(q.toAmount),
    exchange_rate: q.exchangeRate,
    expires_at: q.expiresAt,
  };
}

export function serializePayout(view: View, p: Payout) {
  const destination = view.sandbox.payouts.findDestination(p.destinationId);
  return {
    id: p.id,
    status: p.status,
    amount: formatAmount(p.amount),
    currency: destination?.currency ?? p.amount.currency,
    source_currency: p.totalDebited.currency,
    fee: formatAmount(p.fee),
    total_debited: formatAmount(p.totalDebited),
    destination: p.destinationId,
    reference: p.reference,
    narration: p.narration,
    session_id: destination?.type === 'bank' && destination.currency === 'NGN' ? p.railReference : null,
    failure_reason: p.status === 'failed' ? failureMessage(p.failureReason) : null,
    created_at: p.createdAt,
    completed_at: p.completedAt,
  };
}

// ---------------------------------------------------------------------------
// Connect

export function capabilityStatusForApi(status: string): string {
  return status === 'inactive' ? 'unrequested' : status;
}

export function serializeAccount(view: View, a: ConnectedAccount, options: { readonly single?: boolean } = {}) {
  const attrs = a.attributes as Record<string, unknown>;
  const capabilities = Object.fromEntries(
    Object.entries(a.capabilities).map(([name, c]) => [name, { status: capabilityStatusForApi(c.status), requested: c.requested, ...(name === 'payouts' ? { international: c.international ?? false } : {}) }]),
  );
  return {
    id: a.id,
    name: a.displayName,
    owner_user_id: null,
    parent_organization_id: view.options.organizationId,
    country: a.country,
    entity_type: attrs.entity_type ?? null,
    fee_handling: attrs.fee_collector === 'platform' ? 'customer_pays_fee' : 'account_pays_fee',
    enabled_payment_methods: [],
    adaptive_pricing: false,
    balance_currencies: (attrs.balance_currencies as string[] | undefined) ?? ['USD'],
    phone_number: attrs.phone_number ?? null,
    company_name: attrs.company_name ?? a.displayName,
    enabled_capabilities: Object.entries(a.capabilities).filter(([, c]) => c.status === 'active').map(([n]) => n),
    ...(options.single ? { capabilities } : {}),
    requirements: {
      currently_due: a.requirementsDue,
      eventually_due: [],
      past_due: [],
      pending_verification: [],
      errors: [],
      current_deadline: null,
    },
    is_active: true,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    responsibilities: { fees: { collector: attrs.fee_collector ?? 'bachs' } },
    ...(options.single ? { configuration: attrs.configuration ?? {} } : {}),
    dashboard: attrs.dashboard ?? 'none',
    dashboard_features: attrs.dashboard_features ?? { payout_schedule: false, manual_payouts: false, change_payout_destination: false, refunds: false, disputes: false },
    dashboard_access: attrs.dashboard_access ?? 'not_invited',
    liveness_owed: false,
  };
}

export function serializeCapabilityItem(name: string, c: ConnectedAccount['capabilities'][string]) {
  return {
    name,
    status: capabilityStatusForApi(c.status),
    requested: c.requested,
    status_details: c.status === 'restricted' ? [{ code: 'requirements_outstanding', resolution: 'provide_info', message: 'Provide the outstanding requirements.' }] : null,
    goes_live_automatically: true,
    ...(name === 'payouts' ? { international: c.international ?? false } : {}),
  };
}

export function serializePerson(p: Person) {
  const a = p.attributes as Record<string, unknown>;
  return {
    id: p.id,
    first_name: p.firstName,
    last_name: p.lastName,
    dob: a.dob ?? null,
    address: a.address ?? null,
    phone: p.phone,
    email: p.email,
    id_number_provided: Boolean(a.id_number_provided),
    relationship: a.relationship ?? { representative: false, owner: false, director: false, executive: false, percent_ownership: null, title: null },
    verification: { status: a.id_number_provided ? 'verified' : 'unverified', document_provided: false, failure_reason: null },
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function serializeDocument(d: AccountDocument) {
  return { id: d.id, document_type: d.slot, file_name: d.fileName, uploaded_at: d.createdAt };
}

export function serializeAccountLink(l: AccountLink, accountId: string) {
  return {
    id: l.id,
    object: 'connected_account_link',
    account: accountId,
    type: l.kind,
    created: l.createdAt,
    expires_at: l.expiresAt,
    url: l.url,
    previous_link_superseded: l.supersededPrevious,
  };
}

export function serializeTransfer(view: View, t: Transfer) {
  return {
    id: t.id,
    source: accountIdOf(view, t.sourceOwner),
    destination: accountIdOf(view, t.destinationOwner),
    amount: formatAmount(t.amount),
    currency: t.amount.currency,
    status: 'paid',
    description: t.description,
    metadata: t.metadata,
    transfer_group: t.transferGroup,
    kind: t.kind,
    source_charge_id: t.sourceChargeId,
    created_at: t.createdAt,
  };
}

export function serializePlatformFee(view: View, f: PlatformFee) {
  const charge = view.sandbox.charges.find(f.chargeId);
  return {
    id: f.id,
    charge: f.chargeId,
    collected_from: charge?.transferDestination ? 'seller' : 'merchant',
    earned_by: 'platform',
    amount: formatAmount(f.amount),
    currency: f.amount.currency,
    amount_refunded: formatAmount({ amountMinor: 0n, currency: f.amount.currency }),
    refunded: false,
    created_at: f.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Saved payment methods

export function serializeSavedPaymentMethod(pm: SavedPaymentMethod) {
  const m = pm.method;
  return {
    payment_method_id: pm.id,
    customer: pm.customerId,
    type: m.type,
    card_brand: m.type === 'card' ? m.brand : null,
    card_last4: m.type === 'card' ? m.last4 : null,
    card_exp_month: m.type === 'card' ? (m.expMonth ?? 12) : null,
    card_exp_year: m.type === 'card' ? (m.expYear ?? 2030) : null,
    currency: pm.currency,
    is_default: pm.isDefault,
    created_at: pm.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Webhook endpoints and events

const SCOPE_TO_SOURCE = { own: 'account', connected: 'connect', all: 'all' } as const;

export function serializeWebhookEndpoint(e: WebhookEndpoint, options: { readonly includeSecret?: boolean } = {}) {
  return {
    endpoint_id: e.id,
    name: e.name,
    url: e.url,
    enabled: e.status === 'enabled',
    disabled_at: e.disabledAt,
    disabled_reason: e.disabledReason,
    event_types: e.enabledEvents,
    event_source: SCOPE_TO_SOURCE[e.scope],
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    ...(options.includeSecret ? { signing_secret: e.secret } : {}),
  };
}

function attemptSummary(deliveries: readonly WebhookDelivery[]) {
  const attempted = deliveries.filter((d) => d.status !== 'scheduled' || d.attemptedAt);
  const last = deliveries[0];
  return {
    attempts: deliveries.length,
    success: attempted.filter((d) => d.status === 'succeeded').length,
    failed: attempted.filter((d) => d.status === 'failed' || d.status === 'dropped').length,
    last_attempt_status: last ? (last.status === 'scheduled' ? 'pending' : last.status === 'succeeded' ? 'succeeded' : 'failed') : null,
    last_attempt_http_status: last?.responseStatus ?? null,
    last_attempt_error: last?.error ?? null,
    last_attempt_at: last?.attemptedAt ?? null,
  };
}

export function serializeEndpointEvent(view: View, e: ProviderWebhookEventRecord, endpointId: string) {
  return { event_id: e.id, event_type: e.type, entity_id: e.entityId, ...attemptSummary(view.sandbox.webhooks.listDeliveries({ eventId: e.id, endpointId })) };
}

export function serializeEventListItem(view: View, e: ProviderWebhookEventRecord) {
  return {
    event_id: e.id,
    event_type: e.type,
    entity_type: e.entityType,
    entity_id: e.entityId,
    created_at: e.createdAt,
    account: accountIdOf(view, e.ownerId),
    ...attemptSummary(view.sandbox.webhooks.listDeliveries({ eventId: e.id })),
  };
}

export function serializeAttempt(d: WebhookDelivery) {
  return {
    attempt_id: d.id,
    attempt_no: d.attempt,
    status: d.status === 'scheduled' ? 'pending' : d.status === 'succeeded' ? 'succeeded' : 'failed',
    callback_url: d.url,
    http_status: d.responseStatus,
    response_snippet: d.responseSnippet,
    last_error: d.error,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

export function serializeEventDetail(view: View, e: ProviderWebhookEventRecord, endpointId?: string) {
  return {
    event_id: e.id,
    event_type: e.type,
    entity_type: e.entityType,
    entity_id: e.entityId,
    created_at: e.createdAt,
    payload: e.body,
    attempts: view.sandbox.webhooks.listDeliveries({ eventId: e.id, ...(endpointId ? { endpointId } : {}) }).map(serializeAttempt),
  };
}

export { BACHS };
