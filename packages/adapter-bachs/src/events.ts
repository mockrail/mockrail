import {
  isPlatformOwner,
  localOf,
  nextBilledAt,
  subscriptionAmount,
  type Charge,
  type CheckoutSession,
  type ConnectedAccount,
  type Customer,
  type DomainEvent,
  type Invoice,
  type Payout,
  type PayoutDestination,
  type ProviderWebhookEvent,
  type Refund,
  type Sandbox,
  type SavedPaymentMethod,
  type Subscription,
  type Transfer,
} from '@mockrail/core';
import { formatAmount, formatAmountOrNull, isoMicro } from './money.js';
import type { ResolvedBachsOptions } from './options.js';
import {
  accountIdOf,
  failureMessage,
  paymentMethodDetails,
  serializeCustomer,
  serializeEventCharge,
  serializeInvoice,
  serializeSavedPaymentMethod,
  serializeTransfer,
  destinationType,
  type View,
} from './view.js';

/** Event types this adapter emits. */
export const BACHS_EVENT_TYPES = [
  'collection.succeeded',
  'collection.failed',
  'collection.underpaid',
  'checkout.completed',
  'checkout.expired',
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'payout_destination.approved',
  'payout_destination.rejected',
  'refund.created',
  'refund.paid',
  'refund.failed',
  'account.updated',
  'account.tasks_requested',
  'capability.updated',
  'transfer.created',
  'payment_method.saved',
] as const;

export type BachsEventType = (typeof BACHS_EVENT_TYPES)[number];

interface Mapped {
  readonly type: BachsEventType;
  readonly data: Record<string, unknown>;
  readonly entityType: string;
  readonly entityId: string;
  readonly references?: readonly (string | null | undefined)[];
}

export function createEventMapper(options: ResolvedBachsOptions) {
  return function mapDomainEvent(event: DomainEvent, sandbox: Sandbox): readonly ProviderWebhookEvent[] {
    const view: View = { sandbox, options };
    return toBachs(view, event).map((m) => {
      const id = sandbox.ids.next('evt');
      const body: Record<string, unknown> = {
        id,
        type: m.type,
        created_at: isoMicro(event.occurredAt),
        organization_id: accountIdOf(view, event.ownerId),
        data: m.data,
      };
      // Connect events carry the connected account at the top level.
      if (!isPlatformOwner(event.ownerId)) body.account = localOf(event.ownerId);
      return {
        id,
        type: m.type,
        ownerId: event.ownerId,
        createdAt: event.occurredAt,
        entityType: m.entityType,
        entityId: m.entityId,
        references: [m.entityId, ...(m.references ?? [])].filter((r): r is string => typeof r === 'string'),
        body,
      };
    });
  };
}

function toBachs(view: View, event: DomainEvent): Mapped[] {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'charge.succeeded': {
      const c = d.charge as Charge;
      return [{ type: 'collection.succeeded', data: collectionSucceeded(view, c), entityType: 'charge', entityId: c.id, references: [c.reference, c.checkoutId] }];
    }
    case 'charge.failed': {
      const c = d.charge as Charge;
      return [{ type: 'collection.failed', data: collectionFailed(view, c), entityType: 'charge', entityId: c.id, references: [c.reference, c.checkoutId] }];
    }
    case 'charge.underpaid': {
      const c = d.charge as Charge;
      return [
        {
          type: 'collection.underpaid',
          data: {
            charge_id: c.id,
            reference: c.reference,
            checkout_id: c.checkoutId,
            amount_paid: formatAmount(c.amountReceived),
            amount_expected: formatAmount(c.amount),
            amount_remaining: formatAmount({ amountMinor: c.amount.amountMinor - c.amountReceived.amountMinor, currency: c.amount.currency }),
            currency: c.amount.currency,
            status: 'UNDERPAID',
            metadata: c.metadata,
          },
          entityType: 'charge',
          entityId: c.id,
          references: [c.reference, c.checkoutId],
        },
      ];
    }
    case 'checkout.completed': {
      const s = d.checkout as CheckoutSession;
      return [{ type: 'checkout.completed', data: checkoutData(view, s, (d.charge as Charge | null) ?? null), entityType: 'checkout', entityId: s.id, references: [s.reference, s.chargeId] }];
    }
    case 'checkout.expired': {
      const s = d.checkout as CheckoutSession;
      return [{ type: 'checkout.expired', data: checkoutData(view, s, null), entityType: 'checkout', entityId: s.id, references: [s.reference] }];
    }
    case 'customer.created':
    case 'customer.updated': {
      const c = d.customer as Customer;
      return [{ type: event.type, data: serializeCustomer(c), entityType: 'customer', entityId: c.id }];
    }
    case 'payment_method.saved': {
      const pm = d.paymentMethod as SavedPaymentMethod;
      const customer = view.sandbox.customers.find(pm.customerId);
      return [{ type: 'payment_method.saved', data: { ...serializeSavedPaymentMethod(pm), customer: customer ? serializeCustomer(customer) : null }, entityType: 'payment_method', entityId: pm.id }];
    }
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.canceled': {
      const s = d.subscription as Subscription;
      const type = event.type === 'subscription.created' ? 'customer.subscription.created' : event.type === 'subscription.updated' ? 'customer.subscription.updated' : 'customer.subscription.deleted';
      return [{ type, data: subscriptionData(view, s), entityType: 'subscription', entityId: s.id }];
    }
    case 'invoice.created':
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const i = d.invoice as Invoice;
      const charge = (d.charge as Charge | null | undefined) ?? view.sandbox.charges.find(i.chargeId);
      return [{ type: event.type, data: serializeInvoice(view, i, charge ?? null), entityType: 'invoice', entityId: i.id, references: [charge?.id, i.subscriptionId] }];
    }
    case 'payout.created':
    case 'payout.completed':
    case 'payout.failed': {
      const p = d.payout as Payout;
      const destination = (d.destination as PayoutDestination | null) ?? null;
      const type = event.type === 'payout.created' ? 'payout.created' : event.type === 'payout.completed' ? 'payout.paid' : 'payout.failed';
      return [{ type, data: payoutData(p, destination, type === 'payout.paid'), entityType: 'payout', entityId: p.id, references: [p.reference] }];
    }
    case 'payout_destination.approved':
    case 'payout_destination.rejected': {
      const dest = d.destination as PayoutDestination;
      return [
        {
          type: event.type,
          data: {
            destination_id: dest.id,
            type: destinationType(dest),
            currency: dest.currency,
            status: dest.status,
            status_reason: dest.statusReason,
            is_usable: dest.status === 'approved',
            is_default: dest.isDefault,
            reviewed_at: dest.reviewedAt,
          },
          entityType: 'payout_destination',
          entityId: dest.id,
        },
      ];
    }
    case 'refund.created':
    case 'refund.succeeded':
    case 'refund.failed': {
      const r = d.refund as Refund;
      const type = event.type === 'refund.created' ? 'refund.created' : event.type === 'refund.succeeded' ? 'refund.paid' : 'refund.failed';
      return [{ type, data: refundData(r), entityType: 'refund', entityId: r.id, references: [r.chargeId, r.reference] }];
    }
    case 'account.updated': {
      const a = d.account as ConnectedAccount;
      const attrs = a.attributes as Record<string, unknown>;
      return [
        {
          type: 'account.updated',
          data: { account: a.id, outstanding: a.requirementsDue, dashboard: attrs.dashboard ?? 'none', dashboard_access: attrs.dashboard_access ?? 'not_invited' },
          entityType: 'account',
          entityId: a.id,
        },
      ];
    }
    case 'account.tasks_requested': {
      const a = d.account as ConnectedAccount;
      const tasks = (d.tasks as string[]) ?? [];
      return [{ type: 'account.tasks_requested', data: { account: a.id, task_ids: tasks.map((t) => `task_${t.replace(/[^a-z0-9]/gi, '').slice(0, 16)}`) }, entityType: 'account', entityId: a.id }];
    }
    case 'capability.updated': {
      const a = d.account as ConnectedAccount;
      const status = d.status === 'active' ? 'active' : 'restricted';
      return [
        {
          type: 'capability.updated',
          data: { account: a.id, capability: d.capability, status, requested: d.requested ?? true, ...(d.capability === 'payouts' ? { international: d.international ?? false } : {}) },
          entityType: 'capability',
          entityId: `${a.id}:${String(d.capability)}`,
        },
      ];
    }
    case 'transfer.created': {
      const t = d.transfer as Transfer;
      const s = serializeTransfer(view, t);
      return [
        {
          type: 'transfer.created',
          data: {
            transfer_id: s.id,
            source: s.source,
            destination: s.destination,
            amount: s.amount,
            currency: s.currency,
            description: s.description,
            metadata: s.metadata,
            kind: s.kind,
            source_charge_id: s.source_charge_id,
            created_at: isoMicro(t.createdAt),
          },
          entityType: 'transfer',
          entityId: t.id,
          references: [t.sourceChargeId],
        },
      ];
    }
    default:
      return [];
  }
}

function settlement(c: Charge): { settlement_amount: string; settlement_currency: string; processing_fee: string | null; processing_fee_currency: string | null } {
  const fee = c.processingFee ?? (c.feeRule ? null : null);
  const base = c.status === 'failed' ? c.amount : c.amountReceived;
  return {
    settlement_amount: formatAmount({ amountMinor: base.amountMinor - (fee?.amountMinor ?? 0n), currency: c.amount.currency }),
    settlement_currency: c.amount.currency,
    processing_fee: formatAmountOrNull(fee),
    processing_fee_currency: fee ? fee.currency : null,
  };
}

function productCart(view: View, c: Charge): unknown[] | null {
  const checkout = view.sandbox.checkout.find(c.checkoutId);
  if (!checkout?.lineItems.length) return null;
  return checkout.lineItems.map((l) => ({ product_id: l.productId, quantity: l.quantity, ...(l.priceType === 'custom' ? { amount: formatAmount(l.unitAmount) } : {}) }));
}

/** collection.* customer: `id` (nullable), plus email and name only when collected. */
function collectionCustomer(view: View, c: Charge): Record<string, unknown> {
  const customer = view.sandbox.customers.find(c.customerId);
  const details = view.sandbox.checkout.find(c.checkoutId)?.customerDetails;
  const email = customer?.email ?? details?.email;
  const name = customer?.name ?? details?.name;
  return { id: customer?.id ?? null, ...(email ? { email } : {}), ...(name ? { name } : {}) };
}

function collectionSucceeded(view: View, c: Charge): Record<string, unknown> {
  const overpaid = c.status === 'overpaid';
  return {
    charge_id: c.id,
    checkout_id: c.checkoutId,
    reference: c.reference,
    status: overpaid ? 'OVERPAID' : 'SUCCEEDED',
    amount: formatAmount(c.amount),
    currency: c.amount.currency,
    ...settlement(c),
    fee_bearer: 'merchant',
    product_cart: productCart(view, c),
    customer: collectionCustomer(view, c),
    payment_method_details: paymentMethodDetails(view, c),
    metadata: c.metadata,
    ...(overpaid
      ? {
          expected_amount: formatAmount(c.amount),
          received_amount: formatAmount(c.amountReceived),
          overpaid_amount: formatAmount({ amountMinor: c.amountReceived.amountMinor - c.amount.amountMinor, currency: c.amount.currency }),
        }
      : {}),
  };
}

function collectionFailed(view: View, c: Charge): Record<string, unknown> {
  return {
    charge_id: c.id,
    checkout_id: c.checkoutId,
    reference: c.reference,
    status: 'FAILED',
    amount: formatAmount(c.amount),
    currency: c.amount.currency,
    settlement_amount: formatAmount(c.amount),
    settlement_currency: c.amount.currency,
    reason: failureMessage(c.failureReason),
    product_cart: productCart(view, c),
    customer: collectionCustomer(view, c),
    processing_fee: null,
    processing_fee_currency: null,
    fee_bearer: 'merchant',
    payment_method_details: null,
    metadata: c.metadata,
  };
}

function checkoutData(view: View, s: CheckoutSession, charge: Charge | null): Record<string, unknown> {
  const customer = view.sandbox.customers.find(s.customerId);
  const completed = s.status === 'completed';
  return {
    checkout_id: s.id,
    status: s.status,
    mode: s.mode,
    payment_status: completed ? (charge ? 'paid' : 'no_payment_required') : null,
    amount: formatAmount(s.amount),
    currency: s.amount.currency,
    reference: s.reference,
    customer: customer ? serializeCustomer(customer) : null,
    ...(completed ? { customer_details: s.customerDetails ? { email: s.customerDetails.email, name: s.customerDetails.name } : null } : {}),
    charge: completed && charge ? serializeEventCharge(view, charge) : null,
    subscription: completed && s.subscriptionId ? { subscription_id: s.subscriptionId } : null,
    success_url: s.successUrl,
    cancel_url: s.cancelUrl,
    metadata: s.metadata,
    completed_at: s.completedAt,
    expires_at: s.expiresAt,
    created_at: s.createdAt,
  };
}

function subscriptionData(view: View, s: Subscription): Record<string, unknown> {
  const customer = view.sandbox.customers.find(s.customerId);
  return {
    subscription_id: s.id,
    customer: customer ? serializeCustomer(customer) : null,
    product_id: s.productId,
    status: s.status,
    collection_method: 'charge_automatically',
    currency: s.unitAmount.currency,
    amount: formatAmount(subscriptionAmount(s)),
    billing_cycle: { interval: s.recurring.interval, frequency: s.recurring.intervalCount },
    quantity: s.quantity,
    current_period_start: s.currentPeriodStart,
    current_period_end: s.currentPeriodEnd,
    next_billed_at: nextBilledAt(s),
    trial_end: s.status === 'trialing' ? s.trialEnd : null,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt,
    created_at: s.createdAt,
    items: [],
    metadata: s.metadata,
  };
}

/** payout.* data: amounts in the source currency plus the conversion to the destination. */
function payoutData(p: Payout, destination: PayoutDestination | null, paid: boolean): Record<string, unknown> {
  const cross = p.exchangeRate !== null;
  return {
    withdrawal_id: p.id,
    reference: p.reference,
    ...(paid ? { session_id: destination?.type === 'bank' && destination.currency === 'NGN' ? p.railReference : null } : {}),
    narration: p.narration,
    status: p.status === 'completed' ? 'completed' : p.status === 'failed' ? 'failed' : 'pending',
    amount: formatAmount(p.totalDebited),
    currency: p.totalDebited.currency,
    from_currency: p.totalDebited.currency,
    to_currency: destination?.currency ?? p.amount.currency,
    exchange_rate: cross ? p.exchangeRate : null,
    to_amount: formatAmount(p.amount),
    withdrawal_fee: formatAmount(p.fee),
    net_from_amount: formatAmount({ amountMinor: p.totalDebited.amountMinor - p.fee.amountMinor, currency: p.totalDebited.currency }),
  };
}

/** refund.* data: event status words are processing | paid | failed; fee_bearer merchant | customer. */
function refundData(r: Refund): Record<string, unknown> {
  return {
    refund_id: r.id,
    charge_id: r.chargeId,
    reference: r.reference ?? '',
    status: r.status === 'pending' ? 'processing' : r.status === 'succeeded' ? 'paid' : 'failed',
    requested_amount: formatAmount(r.amount),
    refunded_amount: formatAmount(r.status === 'succeeded' ? r.amount : { amountMinor: 0n, currency: r.amount.currency }),
    refund_fee_amount: formatAmount(r.fee),
    fee_bearer: r.feeBearer,
    reason: r.reason,
  };
}
