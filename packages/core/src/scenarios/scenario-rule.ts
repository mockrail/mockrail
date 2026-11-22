import type { CurrencyCode } from '../money/currency.js';
import type { Money } from '../money/money.js';

export type FailureReason =
  | 'declined'
  | 'insufficient_funds'
  | 'expired_card'
  | 'processing_error'
  | 'account_name_mismatch'
  | 'bank_rejected'
  | 'invalid_destination'
  | 'review_rejected'
  | 'unknown';

export const FAILURE_REASONS: readonly FailureReason[] = [
  'declined',
  'insufficient_funds',
  'expired_card',
  'processing_error',
  'account_name_mismatch',
  'bank_rejected',
  'invalid_destination',
  'review_rejected',
  'unknown',
];

export type ScenarioOutcome =
  | { readonly kind: 'succeed' }
  | { readonly kind: 'fail'; readonly reason: FailureReason }
  | { readonly kind: 'delay'; readonly settleAfterMs: number }
  | { readonly kind: 'partial'; readonly receivedAmount: Money };

/** Operations the scenario engine can decide outcomes for. */
export type OperationName =
  | 'charge.create'
  | 'checkout.pay'
  | 'subscription.renew'
  | 'refund.create'
  | 'payout.create'
  | 'deposit.receive';

export const OPERATIONS: readonly OperationName[] = [
  'charge.create',
  'checkout.pay',
  'subscription.renew',
  'refund.create',
  'payout.create',
  'deposit.receive',
];

export interface OperationMatcher {
  readonly operation: OperationName | '*';
  /** Matches when the resource reference (id or merchant reference) starts with this prefix. */
  readonly referencePrefix?: string;
  readonly ownerId?: string;
  readonly currency?: CurrencyCode;
}

export interface ScenarioRule {
  readonly id: string;
  readonly match: OperationMatcher;
  readonly outcome: ScenarioOutcome;
  readonly remainingUses: number | 'unlimited';
  readonly description?: string;
}

export interface ScenarioContext {
  readonly operation: OperationName;
  /** Ids and merchant references of the resources involved; a rule matches if any starts with its prefix. */
  readonly references?: readonly (string | null | undefined)[];
  readonly ownerId?: string;
  readonly currency?: CurrencyCode;
}

export type FidelityMode = 'sandbox' | 'live';
