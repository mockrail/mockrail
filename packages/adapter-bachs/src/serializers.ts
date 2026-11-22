import type {
  AccountDocument,
  Charge,
  CheckoutSession,
  ConnectedAccount,
  Customer,
  Invoice,
  OwnerBalance,
  Payout,
  PayoutDestination,
  PayoutQuote,
  Person,
  PlatformFee,
  Product,
  Refund,
  Subscription,
  Transfer,
  VirtualAccount,
  WebhookEndpoint,
} from '@mockrail/core';
import { formatDecimal } from '@mockrail/core';
import { formatAmount, formatAmountOrNull, formatCheckoutAmount } from './money.js';
import { apiPaymentType, chargeStatus, checkoutStatus, payoutStatus, refundStatus } from './statuses.js';

/*
 * Field names below follow the Bachs docs where a page documents them (money as decimal strings,
 * ISO 8601 UTC timestamps, status words, available_balance/pending_balance). Object shapes the
 * review did not open one by one are best guesses; see UNVERIFIED.md.
 */

export function serializeCustomer(c: Customer) {
  return {
    id: c.id,
    email: c.email,
    name: c.name,
    phone: c.phone,
    metadata: c.metadata,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export function serializeProduct(p: Product) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: formatAmount(p.price),
    currency: p.price.currency,
    type: p.recurring ? 'recurring' : 'one_time',
    recurring: p.recurring
      ? { interval: p.recurring.interval, interval_count: p.recurring.intervalCount, trial_days: p.recurring.trialDays }
      : null,
    archived: p.archived,
    metadata: p.metadata,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function serializeCheckout(s: CheckoutSession, exposeUndocumentedStatuses: boolean) {
  return {
    id: s.id,
    status: checkoutStatus(s, exposeUndocumentedStatuses),
    url: s.url,
    amount: formatCheckoutAmount(s.amount),
    currency: s.amount.currency,
    product_id: s.productId,
    customer_id: s.customerId,
    customer_email: s.customerEmail,
    payment_methods: s.paymentMethodTypes,
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    reference: s.reference,
    metadata: s.metadata,
    expires_at: s.expiresAt,
    created_at: s.createdAt,
  };
}

export function serializePayment(c: Charge) {
  const { status, substatus } = chargeStatus(c);
  return {
    id: c.id,
    status,
    substatus,
    amount: formatAmount(c.amount),
    amount_received: formatAmount(c.amountReceived),
    amount_refunded: formatAmount(c.amountRefunded),
    currency: c.amount.currency,
    payment_type: apiPaymentType(c),
    card: c.paymentMethod?.type === 'card' ? { brand: c.paymentMethod.brand, last4: c.paymentMethod.last4 } : null,
    checkout_id: c.checkoutId,
    customer_id: c.customerId,
    subscription_id: c.subscriptionId,
    invoice_id: c.invoiceId,
    virtual_account_id: c.virtualAccountId,
    failure_reason: c.failureReason,
    platform_fee: formatAmountOrNull(c.platformFee),
    transfer_data: c.transferDestination ? { destination: c.transferDestination, amount: formatAmountOrNull(c.transferAmount) } : null,
    description: c.description,
    reference: c.reference,
    metadata: c.metadata,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export function serializeSubscription(s: Subscription) {
  return {
    id: s.id,
    status: s.status,
    customer_id: s.customerId,
    product_id: s.productId,
    amount: formatAmount(s.amount),
    currency: s.amount.currency,
    interval: s.recurring.interval,
    interval_count: s.recurring.intervalCount,
    current_period_start: s.currentPeriodStart,
    current_period_end: s.currentPeriodEnd,
    trial_start: s.trialStart,
    trial_end: s.trialEnd,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt,
    cancellation_reason: s.cancellationReason,
    latest_invoice_id: s.latestInvoiceId,
    next_payment_attempt: s.nextPaymentAttempt,
    metadata: s.metadata,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function serializeInvoice(i: Invoice, charge: Charge | null) {
  return {
    id: i.id,
    status: i.status,
    subscription_id: i.subscriptionId,
    customer_id: i.customerId,
    amount_due: formatAmount(i.amount),
    amount_paid: i.status === 'paid' ? formatAmount(i.amount) : formatDecimal(0n, i.amount.currency),
    currency: i.amount.currency,
    billing_reason: i.billingReason,
    attempt_count: i.attemptCount,
    next_payment_attempt: i.nextPaymentAttempt,
    // Discrepancy #5: populated once collection has been attempted, including failed attempts.
    charge: charge ? serializePayment(charge) : null,
    period_start: i.periodStart,
    period_end: i.periodEnd,
    paid_at: i.paidAt,
    created_at: i.createdAt,
  };
}

export function serializeVirtualAccount(v: VirtualAccount) {
  return {
    id: v.id,
    account_number: v.accountNumber,
    account_name: v.accountName,
    bank_name: v.bankName,
    currency: v.currency,
    customer_id: v.customerId,
    created_at: v.createdAt,
  };
}

export function serializeRefund(r: Refund) {
  return {
    id: r.id,
    payment_id: r.chargeId,
    amount: formatAmount(r.amount),
    currency: r.amount.currency,
    status: refundStatus(r),
    reason: r.reason,
    failure_reason: r.failureReason,
    metadata: r.metadata,
    created_at: r.createdAt,
    completed_at: r.completedAt,
  };
}

export function serializeDestination(d: PayoutDestination) {
  return {
    id: d.id,
    type: d.type,
    currency: d.currency,
    country: d.country,
    bank_code: d.bankCode,
    bank_name: d.bankName,
    account_number: d.accountNumber,
    account_name: d.accountName,
    address: d.cryptoAddress,
    network: d.network,
    phone_number: d.phone,
    provider: d.mobileProvider,
    recipient: d.recipient,
    metadata: d.metadata,
    created_at: d.createdAt,
  };
}

export function serializeQuote(q: PayoutQuote) {
  return {
    id: q.id,
    amount: formatAmount(q.amount),
    fee: formatAmount(q.fee),
    total: formatAmount(q.total),
    currency: q.amount.currency,
    destination_id: q.destinationId,
    expires_at: q.expiresAt,
    created_at: q.createdAt,
  };
}

export function serializePayout(p: Payout) {
  return {
    id: p.id,
    status: payoutStatus(p),
    amount: formatAmount(p.amount),
    fee: formatAmount(p.fee),
    currency: p.amount.currency,
    destination_id: p.destinationId,
    quote_id: p.quoteId,
    failure_reason: p.failureReason,
    reference: p.reference,
    description: p.description,
    metadata: p.metadata,
    created_at: p.createdAt,
    completed_at: p.completedAt,
    failed_at: p.failedAt,
  };
}

export function serializeBalance(b: OwnerBalance) {
  return {
    currency: b.currency,
    available_balance: formatDecimal(b.available, b.currency),
    pending_balance: formatDecimal(b.pending, b.currency),
  };
}

export function serializeAccount(a: ConnectedAccount) {
  return {
    id: a.id,
    type: a.type,
    email: a.email,
    country: a.country,
    business_name: a.businessName,
    business_type: a.businessType,
    default_currency: a.defaultCurrency,
    capabilities: a.capabilities,
    requirements: { currently_due: a.requirementsDue },
    metadata: a.metadata,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

export function serializePerson(p: Person) {
  return {
    id: p.id,
    account: p.accountId,
    first_name: p.firstName,
    last_name: p.lastName,
    email: p.email,
    phone: p.phone,
    roles: p.roles,
    metadata: p.metadata,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

export function serializeDocument(d: AccountDocument) {
  return { id: d.id, account: d.accountId, person: d.personId, purpose: d.purpose, file_name: d.fileName, created_at: d.createdAt };
}

export function serializeTransfer(t: Transfer) {
  return {
    id: t.id,
    destination: t.destination,
    amount: formatAmount(t.amount),
    currency: t.amount.currency,
    source_payment_id: t.sourceChargeId,
    description: t.description,
    metadata: t.metadata,
    created_at: t.createdAt,
  };
}

export function serializePlatformFee(f: PlatformFee) {
  return {
    id: f.id,
    account: f.accountId,
    payment_id: f.chargeId,
    amount: formatAmount(f.amount),
    currency: f.amount.currency,
    created_at: f.createdAt,
  };
}

export function serializeWebhookEndpoint(e: WebhookEndpoint, options: { readonly includeSecret?: boolean } = {}) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    enabled_events: e.enabledEvents,
    status: e.status,
    disabled_reason: e.disabledReason,
    ...(options.includeSecret ? { secret: e.secret } : {}),
    metadata: e.metadata,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
  };
}
