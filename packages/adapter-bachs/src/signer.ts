import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DeliveryPolicy, DeliveryResult, WebhookSigner } from '@mockrail/core';
import { BACHS } from './constants.js';

export const BACHS_HEADERS = {
  timestamp: 'X-Bachs-Timestamp',
  signature: 'X-Bachs-Signature',
  signatureV2: 'X-Bachs-Signature-V2',
} as const;

/** HMAC-SHA256 hex of "{timestamp}.{raw_body}" with the endpoint secret. */
export function computeBachsSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/**
 * Sends the legacy `X-Bachs-Signature` (current secret) and `X-Bachs-Signature-V2: t=<ts>,v1=<sig>`
 * with one v1 per valid secret, so receivers keep working during a 24-hour rotation overlap.
 */
export const bachsWebhookSigner: WebhookSigner = {
  sign({ rawBody, timestamp, secrets }) {
    const ts = Math.floor(timestamp.getTime() / 1000).toString();
    const signatures = secrets.map((secret) => computeBachsSignature(secret, ts, rawBody));
    return {
      [BACHS_HEADERS.timestamp]: ts,
      [BACHS_HEADERS.signature]: signatures[0] ?? '',
      [BACHS_HEADERS.signatureV2]: [`t=${ts}`, ...signatures.map((s) => `v1=${s}`)].join(','),
    };
  },
};

export interface VerifyBachsSignatureInput {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly secret: string;
  /** Reject signatures older than this many seconds (default 300). */
  readonly toleranceSeconds?: number;
  readonly now?: Date;
}

/** Verifies a delivery the way a receiver should: V2 header first, legacy header as fallback. */
export function verifyBachsSignature(input: VerifyBachsSignatureInput): boolean {
  const header = (name: string): string | undefined => {
    const value = input.headers[name] ?? input.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const v2 = header(BACHS_HEADERS.signatureV2);
  let timestamp = header(BACHS_HEADERS.timestamp);
  let candidates: string[] = [];
  if (v2) {
    const parts = v2.split(',').map((p) => p.trim().split('=') as [string, string]);
    timestamp = parts.find(([k]) => k === 't')?.[1] ?? timestamp;
    candidates = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  } else {
    const legacy = header(BACHS_HEADERS.signature);
    if (legacy) candidates = [legacy];
  }
  if (!timestamp || candidates.length === 0) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - Number(timestamp)) > tolerance) return false;
  const expected = Buffer.from(computeBachsSignature(input.secret, timestamp, input.rawBody));
  return candidates.some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * Success = any 2xx within 10 s. Retries on timeout, connection error, 5xx, 408 and 429;
 * up to 5 attempts at about +1, +5, +15 and +60 minutes.
 */
export const bachsDeliveryPolicy: DeliveryPolicy = {
  maxAttempts: BACHS.webhookMaxAttempts,
  retryDelaysMs: BACHS.webhookRetryDelaysMs,
  timeoutMs: BACHS.webhookTimeoutMs,
  isSuccess: (status) => status >= 200 && status < 300,
  isRetryable(result: DeliveryResult): boolean {
    if (result.error) return true;
    const status = result.status ?? 0;
    return status >= 500 || status === 408 || status === 429;
  },
  autoDisable: {
    warnAfterMs: BACHS.webhookWarnAfterMs,
    disableAfterMs: BACHS.webhookDisableAfterMs,
    minAfterWarningMs: BACHS.webhookMinAfterWarningMs,
  },
};
