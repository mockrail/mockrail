import {
  PLATFORM_OWNER,
  type Charge,
  type CheckoutSession,
  type ConnectedAccount,
  type DomainEvent,
  type Invoice,
  type Payout,
  type ProviderWebhookEvent,
  type Refund,
  type Sandbox,
  type Subscription,
  type SubscriptionStatus,
  type Transfer,
} from '@mockrail/core';
import { formatAmount, formatCheckoutAmount } from './money.js';
import type { ResolvedBachsOptions } from './options.js';
import {
  serializeAccount,
  serializeCheckout,
  serializeInvoice,
  serializePayment,
  serializePayout,
  serializeRefund,
  serializeSubscription,
  serializeTransfer,
} from './serializers.js';
import { webhookChargeStatus, webhookPaymentType } from './statuses.js';

/** Event types this adapter can emit, with whether the review opened the event's own page. */
export const BACHS_EVENT_TYPES = {
  'collection.succeeded': { payloadVerified: true },
  'collection.underpaid': { payloadVerified: true },
  'checkout.completed': { payloadVerified: true },
  'checkout.expired': { payloadVerified: false },
  'invoice.paid': { payloadVerified: false },
  'invoice.payment_failed': { payloadVerified: true },
  'subscription.created': { payloadVerified: false },
  'subscription.updated': { payloadVerified: false },
  'subscription.canceled': { payloadVerified: false },
  'refund.created': { payloadVerified: false },
  'refund.paid': { payloadVerified: false },
  'refund.failed': { payloadVerified: false },
  'payout.paid': { payloadVerified: false },
  'payout.failed': { payloadVerified: false },
  'account.updated': { payloadVerified: false },
  'account.tasks.requested': { payloadVerified: false },
  'capability.updated': { payloadVerified: false },
  'transfer.created': { payloadVerified: false },
} as const;

export type BachsEventType = keyof typeof BACHS_EVENT_TYPES;

/**
 * Subscription transitions with no documented event (discrepancy #14). The adapter emits
 * only documented events, so these produce no webhook.
 */
const UNDOCUMENTED_TRANSITIONS: readonly [SubscriptionStatus | '*', SubscriptionStatus][] = [
  ['*', 'past_due'],
  ['unpaid', 'active'],
];

export function createEventMapper(options: ResolvedBachsOptions) {
  return function mapDomainEvent(event: DomainEvent, sandbox: Sandbox): readonly ProviderWebhookEvent[] {
    const envelope = (type: BachsEventType, data: Record<string, unknown>): ProviderWebhookEvent => {
      const id = sandbox.ids.next('evt');
      const body: Record<string, unknown> = {
        id,
        type,
        created_at: event.occurredAt,
        organization_id: options.organizationId,
        data,
      };
      // Connect events carry the connected account at the top level.
      if (event.ownerId !== PLATFORM_OWNER) body.account = event.ownerId;
      return { id, type, ownerId: event.ownerId, createdAt: event.occurredAt, body };
    };
    const d = event.data as Record<string, unknown>;

    switch (event.type) {
      case 'charge.succeeded':
        return [envelope('collection.succeeded', collectionData(d.charge as Charge, sandbox))];
      case 'charge.underpaid': {
        const charge = d.charge as Charge;
        const remaining = { amountMinor: charge.amount.amountMinor - charge.amountReceived.amountMinor, currency: charge.amount.currency };
        return [envelope('collection.underpaid', { ...collectionData(charge, sandbox), amount_remaining: formatAmount(remaining) })];
      }
      case 'checkout.completed':
        return [envelope('checkout.completed', checkoutCompletedData(d.checkout as CheckoutSession, (d.charge as Charge | null) ?? null, sandbox))];
      case 'checkout.expired':
        return [envelope('checkout.expired', { ...serializeCheckout(d.checkout as CheckoutSession, true), status: 'expired' })];
      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = d.invoice as Invoice;
        const charge = (d.charge as Charge | undefined) ?? sandbox.charges.find(invoice.chargeId);
        return [envelope(event.type, serializeInvoice(invoice, charge ?? null))];
      }
      case 'subscription.created':
        return [envelope('subscription.created', serializeSubscription(d.subscription as Subscription))];
      case 'subscription.canceled':
        return [envelope('subscription.canceled', serializeSubscription(d.subscription as Subscription))];
      case 'subscription.updated': {
        const subscription = d.subscription as Subscription;
        const previous = d.previousStatus as SubscriptionStatus;
        const undocumented = UNDOCUMENTED_TRANSITIONS.some(
          ([from, to]) => to === subscription.status && previous !== subscription.status && (from === '*' || from === previous),
        );
        if (undocumented) return [];
        return [envelope('subscription.updated', { ...serializeSubscription(subscription), previous_status: previous })];
      }
      case 'refund.created':
        return [envelope('refund.created', serializeRefund(d.refund as Refund))];
      case 'refund.succeeded':
        return [envelope('refund.paid', serializeRefund(d.refund as Refund))];
      case 'refund.failed':
        return [envelope('refund.failed', serializeRefund(d.refund as Refund))];
      case 'payout.completed':
        return [envelope('payout.paid', serializePayout(d.payout as Payout))];
      case 'payout.failed':
        return [envelope('payout.failed', serializePayout(d.payout as Payout))];
      case 'account.updated':
        return [envelope('account.updated', serializeAccount(d.account as ConnectedAccount))];
      case 'account.tasks_requested':
        return [envelope('account.tasks.requested', { ...serializeAccount(d.account as ConnectedAccount), tasks: d.tasks })];
      case 'capability.updated':
        return [
          envelope('capability.updated', {
            id: d.capability,
            account: (d.account as ConnectedAccount).id,
            status: d.status,
            previous_status: d.previousStatus,
          }),
        ];
      case 'transfer.created':
        return [envelope('transfer.created', serializeTransfer(d.transfer as Transfer))];
      default:
        return [];
    }
  };
}

/** Payload of collection.succeeded / collection.underpaid. Deposits carry checkout_id null and sender details. */
function collectionData(charge: Charge, sandbox: Sandbox): Record<string, unknown> {
  const customer = sandbox.customers.find(charge.customerId);
  const virtualAccount = sandbox.virtualAccounts.find(charge.virtualAccountId);
  const method = charge.paymentMethod;
  return {
    id: charge.id,
    payment_id: charge.id,
    status: webhookChargeStatus(charge),
    amount: formatAmount(charge.amount),
    amount_received: formatAmount(charge.amountReceived),
    currency: charge.amount.currency,
    payment_type: webhookPaymentType(charge),
    checkout_id: charge.checkoutId,
    subscription_id: charge.subscriptionId,
    invoice_id: charge.invoiceId,
    // Discrepancy #3: collection events use customer.id, which may be null.
    customer: { id: customer?.id ?? null, email: customer?.email ?? null, name: customer?.name ?? null },
    sender:
      method?.type === 'bank_transfer'
        ? { name: method.senderName, account_number: method.senderAccountNumber, bank_name: method.senderBankName }
        : null,
    virtual_account: virtualAccount
      ? { id: virtualAccount.id, account_number: virtualAccount.accountNumber, bank_name: virtualAccount.bankName }
      : null,
    reference: charge.reference,
    metadata: charge.metadata,
    created_at: charge.createdAt,
  };
}

/** Payload of checkout.completed. Uses customer.customer_id (discrepancy #3) and embeds the payment as data.charge. */
function checkoutCompletedData(checkout: CheckoutSession, charge: Charge | null, sandbox: Sandbox): Record<string, unknown> {
  const customer = sandbox.customers.find(checkout.customerId);
  return {
    id: checkout.id,
    checkout_id: checkout.id,
    status: 'completed',
    amount: formatCheckoutAmount(checkout.amount),
    currency: checkout.amount.currency,
    product_id: checkout.productId,
    subscription_id: checkout.subscriptionId,
    customer: { customer_id: customer?.id ?? null, email: customer?.email ?? checkout.customerEmail, name: customer?.name ?? checkout.customerName },
    charge: charge ? serializePayment(charge) : null,
    reference: checkout.reference,
    metadata: checkout.metadata,
    completed_at: checkout.completedAt,
  };
}
