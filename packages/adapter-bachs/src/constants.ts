import { DAY, HOUR, MINUTE, SECOND, type FeeRule, type IdFormats } from '@mockrail/core';

/**
 * Values documented by Bachs (docs.bachs.io, re-read 22 Nov 2026). Each group names its page.
 * Values marked SANDBOX CHOICE are not documented and were picked for the mock.
 */
export const BACHS = {
  providerId: 'bachs',
  displayName: 'Bachs',

  // API standards / authentication
  sandboxKeyPrefix: 'sk_sandbox_',
  liveKeyPrefix: 'sk_live_',
  sandboxRateLimitPerMinute: 100,

  // Pagination: default 20, values above 100 are clamped. Individual list endpoints override the default.
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

  // Create a checkout session
  checkoutExpiryMinutes: { min: 1, max: 1440, default: 60 },
  maxCartItems: 20,

  // Virtual accounts overview: sandbox numbers start with 90 and show this bank name.
  virtualAccountPrefix: '90',
  virtualAccountLength: 10,
  virtualAccountSandboxBankName: 'Sandbox Test Bank',
  virtualAccountBanks: { '103': 'Globus Bank', '090645': 'Nombank MFB', '110072': 'Bank78 MFB' } as Readonly<Record<string, string>>,

  // Deposit limits: per deposit and per UTC day, NGN 5,000,000 each by default.
  ngnDepositLimitMinor: 5_000_000_00n,

  // Recover failed payments
  subscriptionRetryDelaysMs: [1 * DAY, 3 * DAY, 5 * DAY],

  // Payouts via API: quotes last 30 seconds.
  payoutQuoteTtlMs: 30 * SECOND,
  payoutDefaultNarration: 'Bachs Payout',

  // Refunds guide: the idempotency_key window.
  refundIdempotencyWindowMs: 24 * HOUR,
} as const;

/** ID prefixes from the docs' examples and Agent Instructions block. */
export const BACHS_ID_FORMATS: IdFormats = {
  customer: 'cust',
  checkout: 'chk',
  invoice: 'inv',
  refund: 'rfnd',
  payout_destination: 'pd',
  payout_quote: 'pqt',
  payout: 'pay',
  platform_fee: 'pf',
  person: 'per',
  account_link: 'alnk',
  subscription_item: 'si',
  payment_method: 'pm',
  webhook_endpoint: { prefix: 'whe', alphabet: 'hex', length: 32 },
  webhook_attempt: { prefix: 'wha', alphabet: 'hex', length: 32 },
};

/** whsec_ followed by 64 hex characters (create endpoint example). */
export const WEBHOOK_SECRET_FORMAT = { prefix: 'whsec_', alphabet: 'hex', length: 64 } as const;

/** Sandbox test cards (Sandbox page; Charge a saved card guide). Any other number succeeds. */
export const TEST_CARDS = [
  { number: '4000000000000002', reason: 'declined', description: 'Declined' },
  { number: '4000000000009995', reason: 'insufficient_funds', description: 'Insufficient funds' },
  { number: '4000000000000069', reason: 'expired_card', description: 'Expired card' },
  { number: '4000000000000119', reason: 'processing_error', description: 'Processing error' },
] as const;

/** Saves at checkout, then later off-session charges are declined (Charge a saved card guide). */
export const SAVE_THEN_DECLINE_CARD = '4000000000000341';

/** Withdrawal triggers (Connect testing page). Mobile money has none and completes after a short delay. */
export const PAYOUT_TRIGGERS = {
  bankComplete: { bankCode: '999', accountNumber: '0001112223' },
  bankFail: { bankCode: '998', accountNumber: '0001112224' },
  cryptoComplete: `0x${'1'.repeat(40)}`,
  cryptoFail: `0x${'2'.repeat(40)}`,
} as const;

/** Capabilities per configuration (Capabilities guide). */
export const CAPABILITIES = {
  merchant: ['card_collection', 'ngn_card_collection', 'bank_transfer', 'mobile_money', 'crypto', 'virtual_accounts'],
  recipient: ['payouts', 'transfers', 'conversions'],
} as const;

/** Checkout payment corridors (Create a checkout session). */
export const PAYMENT_METHOD_TYPES = [
  'USD_CARD',
  'NGN_CARD',
  'NGN_BANK_TRANSFER',
  'MOMO_GHS',
  'MOMO_KES',
  'MOMO_TZS',
  'MOMO_UGX',
  'MOMO_XAF',
  'MOMO_XOF',
  'MOMO_RWF',
  'MOMO_MWK',
  'MOMO_ZMW',
  'CRYPTO',
] as const;

/** Event types endpoints can subscribe to (create endpoint enum), plus the Connect events the overview lists. */
export const WEBHOOK_EVENT_TYPES = [
  'collection.succeeded',
  'collection.failed',
  'collection.underpaid',
  'checkout.completed',
  'checkout.expired',
  'payout.created',
  'payout.paid',
  'payout.failed',
  'refund.created',
  'refund.paid',
  'refund.failed',
  'conversion.completed',
  'conversion.failed',
  'customer.created',
  'customer.updated',
  'dispute.created',
  'dispute.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  // Connect events: listed in the webhooks overview, missing from the create enum (contradiction).
  'account.updated',
  'account.tasks_requested',
  'capability.updated',
  'transfer.created',
  'payout_destination.approved',
  'payout_destination.rejected',
] as const;

/** Processing fees (Fees page; Virtual accounts overview). Undocumented methods carry no fee. */
export const COLLECTION_FEES: Readonly<Record<string, FeeRule>> = {
  NGN_BANK_TRANSFER: { percentBps: 150, capMinor: 2_000_00n },
  NGN_CARD: { percentBps: 200 },
  VIRTUAL_ACCOUNT_DEPOSIT: { percentBps: 100, capMinor: 300_00n },
};

/** Withdrawal fees (Fees page), in the currency withdrawn from. Minor units assume 2-decimal currencies. */
export const PAYOUT_FEES = {
  ngnBank: { percentBps: 0, flatMinor: 50_00n } satisfies FeeRule,
  usdBank: { percentBps: 100, minMinor: 1_00n, capMinor: 15_00n } satisfies FeeRule,
  usdMobileMoney: { percentBps: 100, minMinor: 1_00n } satisfies FeeRule,
  crypto: { percentBps: 100, minMinor: 1_00n } satisfies FeeRule,
  otherBank: { percentBps: 30 } satisfies FeeRule,
  otherMobileMoney: { percentBps: 30 } satisfies FeeRule,
} as const;

/**
 * SANDBOX CHOICE: fixed exchange rates, units of each currency per 1 USD. The docs show live rates
 * only (examples use 1500 and 1650 NGN per USD).
 */
export const SANDBOX_USD_RATES: Readonly<Record<string, number>> = {
  USD: 1,
  NGN: 1500,
  GHS: 15,
  KES: 130,
  ZAR: 18,
  MWK: 1735,
  RWF: 1400,
  TZS: 2600,
  UGX: 3700,
  XAF: 600,
  XOF: 600,
  ZMW: 27,
  GBP: 0.79,
  EUR: 0.92,
  CAD: 1.37,
};

/** SANDBOX CHOICE: names for Nigerian bank codes when resolving an NGN destination. */
export const NG_BANKS: Readonly<Record<string, string>> = {
  '044': 'Access Bank',
  '058': 'Guaranty Trust Bank',
  '011': 'First Bank of Nigeria',
  '033': 'United Bank for Africa',
  '057': 'Zenith Bank',
  '999': 'Sandbox Test Bank',
  '998': 'Sandbox Test Bank',
};

/** SANDBOX CHOICE: the account holder name returned when the sandbox "resolves" an NGN account. */
export const SANDBOX_RESOLVED_ACCOUNT_NAME = 'SANDBOX ACCOUNT HOLDER';
