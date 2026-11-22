import type { Charge, CheckoutSession, PaymentMethod, Payout, Refund } from '@mockrail/core';

/** Charge status in API objects (lowercase), per the Payment statuses page. */
export type BachsChargeStatus =
  | 'open'
  | 'incomplete'
  | 'succeeded'
  | 'accepted'
  | 'underpaid'
  | 'overpaid'
  | 'failed'
  | 'refunded'
  | 'partially_refunded'
  | 'auto_refunded';

export type BachsChargeSubstatus =
  | 'awaiting_payment'
  | 'awaiting_approval'
  | 'abandoned'
  | 'expired'
  | 'insufficient_funds'
  | 'declined'
  | null;

export function chargeStatus(charge: Charge): { status: BachsChargeStatus; substatus: BachsChargeSubstatus } {
  switch (charge.status) {
    case 'pending':
      return { status: 'open', substatus: null };
    case 'failed':
      return { status: 'failed', substatus: charge.failureReason === 'insufficient_funds' ? 'insufficient_funds' : 'declined' };
    case 'underpaid':
      return { status: 'underpaid', substatus: null };
    case 'succeeded':
    case 'overpaid': {
      const refunded = charge.amountRefunded.amountMinor;
      if (refunded > 0n && refunded >= charge.amountReceived.amountMinor) return { status: 'refunded', substatus: null };
      if (refunded > 0n) return { status: 'partially_refunded', substatus: null };
      return { status: charge.status, substatus: null };
    }
  }
}

/** Webhooks use uppercase: SUCCEEDED/ACCEPTED/OVERPAID in collection.succeeded, UNDERPAID in collection.underpaid. */
export function webhookChargeStatus(charge: Charge): 'SUCCEEDED' | 'OVERPAID' | 'UNDERPAID' {
  if (charge.status === 'underpaid') return 'UNDERPAID';
  if (charge.status === 'overpaid') return 'OVERPAID';
  return 'SUCCEEDED';
}

/** Refund status words: processing, success, failed. */
export function refundStatus(refund: Refund): 'processing' | 'success' | 'failed' {
  return refund.status === 'pending' ? 'processing' : refund.status === 'succeeded' ? 'success' : 'failed';
}

/** Payout status words match the core: pending, processing, completed, failed. */
export function payoutStatus(payout: Payout): Payout['status'] {
  return payout.status;
}

/**
 * Only "open" is documented for checkout sessions (discrepancy #15). By default the API keeps
 * showing "open" and completion is visible through events; the option exposes the core status.
 */
export function checkoutStatus(session: CheckoutSession, exposeUndocumented: boolean): string {
  return exposeUndocumented ? session.status : 'open';
}

/** Payment type in API objects and the payments filter (`ngn_bank_transfer`, discrepancy #12). */
export function apiPaymentType(charge: Charge): string | null {
  const method = charge.paymentMethod;
  if (!method) return null;
  if (method.type === 'bank_transfer') return charge.amount.currency === 'NGN' ? 'ngn_bank_transfer' : 'bank_transfer';
  return method.type;
}

/** Payment type in webhook payloads (`bank_transfer`, discrepancy #12). */
export function webhookPaymentType(charge: Charge): string | null {
  return charge.paymentMethod?.type ?? null;
}

/** Maps the `payment_type` filter value back to a core payment method type. */
export function paymentTypeFilter(value: string | undefined): PaymentMethod['type'] | undefined {
  switch (value) {
    case 'ngn_bank_transfer':
    case 'bank_transfer':
      return 'bank_transfer';
    case 'card':
    case 'crypto':
    case 'mobile_money':
      return value;
    default:
      return undefined;
  }
}
