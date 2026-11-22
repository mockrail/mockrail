import { DAY, HOUR, MINUTE, SECOND } from '@mockrail/core';

/**
 * Values documented by Bachs (checked against docs.bachs.io on 21 Nov 2026).
 * Each line names the page it came from.
 */
export const BACHS = {
  providerId: 'bachs',
  displayName: 'Bachs',

  // API standards
  sandboxKeyPrefix: 'sk_sandbox_',
  liveKeyPrefix: 'sk_live_',
  sandboxRateLimitPerMinute: 100,

  // Pagination
  defaultPageLimit: 20,
  maxPageLimit: 100,

  // Idempotency
  idempotencyHeader: 'idempotency-key',
  idempotencyTtlMs: 24 * HOUR,

  // Webhooks overview
  webhookTimeoutMs: 10 * SECOND,
  webhookMaxAttempts: 5,
  webhookRetryDelaysMs: [1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE],
  webhookSecretOverlapMs: 24 * HOUR,
  webhookWarnAfterMs: 24 * HOUR,
  webhookDisableAfterMs: 72 * HOUR,
  webhookMinAfterWarningMs: 48 * HOUR,

  // Checkout sessions
  checkoutExpiryMinutes: { min: 1, max: 1440, default: 60 },

  // Virtual accounts
  virtualAccountPrefix: '90',
  virtualAccountLength: 10,
  virtualAccountBankName: 'Sandbox Test Bank',
  ngnDepositLimitMinor: 5_000_000_00n,

  // Subscriptions: failed payments
  subscriptionRetryDelaysMs: [1 * DAY, 3 * DAY, 5 * DAY],

  // Payouts via API
  payoutQuoteTtlMs: 30 * SECOND,
} as const;

/** Sandbox test cards (Sandbox page). Any other number succeeds. */
export const TEST_CARDS = [
  { number: '4000000000000002', reason: 'declined', description: 'Declined' },
  { number: '4000000000009995', reason: 'insufficient_funds', description: 'Insufficient funds' },
  { number: '4000000000000069', reason: 'expired_card', description: 'Expired card' },
  { number: '4000000000000119', reason: 'processing_error', description: 'Processing error' },
] as const;

/** Withdrawal triggers (Connect testing page). Mobile money has none and completes after a short delay. */
export const PAYOUT_TRIGGERS = {
  bankComplete: { bankCode: '999', accountNumber: '0001112223' },
  bankFail: { bankCode: '998', accountNumber: '0001112224' },
  cryptoComplete: `0x${'1'.repeat(40)}`,
  cryptoFail: `0x${'2'.repeat(40)}`,
} as const;

/** Capabilities the official sandbox grants automatically on create (Connect testing page). */
export const AUTO_GRANTED_CAPABILITIES = ['conversions'] as const;
