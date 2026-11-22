import { SandboxError, type ProviderErrorResponse, type SandboxErrorCode } from '@mockrail/core';

/** Core error code -> Bachs error_code and HTTP status (Error reference). */
export const ERROR_CODES: Readonly<Record<SandboxErrorCode, { readonly code: string; readonly status: number }>> = {
  bad_request: { code: 'BAD_REQUEST', status: 400 },
  validation_failed: { code: 'VALIDATION_ERROR', status: 400 },
  unauthorized: { code: 'UNAUTHORIZED', status: 401 },
  forbidden: { code: 'FORBIDDEN', status: 403 },
  not_found: { code: 'NOT_FOUND', status: 404 },
  conflict: { code: 'CONFLICT', status: 409 },
  invalid_state: { code: 'BAD_REQUEST', status: 400 },
  idempotency_conflict: { code: 'IDEMPOTENCY_CONFLICT', status: 409 },
  idempotency_in_progress: { code: 'IDEMPOTENCY_IN_PROGRESS', status: 409 },
  rate_limited: { code: 'TOO_MANY_REQUESTS', status: 429 },
  insufficient_balance: { code: 'INSUFFICIENT_BALANCE', status: 400 },
  quote_expired: { code: 'QUOTE_EXPIRED', status: 400 },
  recipient_incomplete: { code: 'PAYOUT_RECIPIENT_INCOMPLETE', status: 400 },
  refund_not_allowed: { code: 'BAD_REQUEST', status: 400 },
  internal: { code: 'INTERNAL_SERVER_ERROR', status: 500 },
};

/** Core reason (details.reason) -> Bachs error_code and status, from the Error reference tables. */
export const REASON_CODES: Readonly<Record<string, { readonly code: string; readonly status: number }>> = {
  product_not_found: { code: 'PRODUCT_NOT_FOUND', status: 400 },
  product_archived: { code: 'PRODUCT_ARCHIVED', status: 400 },
  custom_amount_required: { code: 'CUSTOM_AMOUNT_REQUIRED', status: 400 },
  fixed_amount_override_not_allowed: { code: 'FIXED_AMOUNT_OVERRIDE_NOT_ALLOWED', status: 400 },
  cart_currency_mismatch: { code: 'CART_CURRENCY_MISMATCH', status: 400 },
  heterogeneous_price_types: { code: 'HETEROGENEOUS_PRICE_TYPES', status: 422 },
  recurring_interval_immutable: { code: 'RECURRING_INTERVAL_IMMUTABLE', status: 400 },
  subscription_not_trialing: { code: 'SUBSCRIPTION_NOT_TRIALING', status: 400 },
  subscription_trial_ends_in_paid_period: { code: 'SUBSCRIPTION_TRIAL_ENDS_IN_PAID_PERIOD', status: 400 },
  subscription_already_canceled: { code: 'SUBSCRIPTION_ALREADY_CANCELED', status: 400 },
  subscription_not_modifiable: { code: 'SUBSCRIPTION_NOT_MODIFIABLE', status: 400 },
  plan_not_priced_in_currency: { code: 'PLAN_NOT_PRICED_IN_CURRENCY', status: 400 },
  destination_pending_review: { code: 'DESTINATION_PENDING_REVIEW', status: 400 },
  destination_rejected: { code: 'DESTINATION_REJECTED', status: 400 },
  quote_not_found: { code: 'QUOTE_NOT_FOUND', status: 400 },
  quote_expired: { code: 'QUOTE_EXPIRED', status: 400 },
  quote_not_applicable: { code: 'QUOTE_NOT_APPLICABLE', status: 400 },
  quote_destination_mismatch: { code: 'QUOTE_DESTINATION_MISMATCH', status: 400 },
  amount_required: { code: 'AMOUNT_REQUIRED', status: 400 },
  refund_exists: { code: 'CONFLICT', status: 409 },
};

/** Throw a Bachs-specific error code directly from a route. */
export function bachsError(code: string, status: number, detail: string, options: { readonly field?: string; readonly details?: Record<string, unknown> } = {}): SandboxError {
  return new SandboxError(status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'bad_request', detail, {
    status,
    details: { ...(options.details ?? {}), error_code: code },
    ...(options.field ? { fieldErrors: [{ field: options.field, message: detail }] } : {}),
  });
}

/**
 * Bachs errors are flat: detail and error_code always; errors[] ({field, message, type}) when there
 * are field problems; doc_url optional; details only for limit-style errors.
 */
export function renderBachsError(error: SandboxError): ProviderErrorResponse {
  const { error_code: explicit, reason, ...rest } = error.details as Record<string, unknown>;
  const byReason = typeof reason === 'string' ? REASON_CODES[reason] : undefined;
  const base = ERROR_CODES[error.code];
  const code = typeof explicit === 'string' ? explicit : (byReason?.code ?? base.code);
  const status = typeof explicit === 'string' ? error.status : (byReason?.status ?? (error.status === 422 ? 422 : base.status));
  const body: Record<string, unknown> = { detail: error.message, error_code: code };
  if (error.fieldErrors.length) body.errors = error.fieldErrors.map((e) => ({ field: e.field, message: e.message, type: 'value_error' }));
  if (Object.keys(rest).length && (error.code === 'insufficient_balance' || error.code === 'rate_limited' || code.endsWith('_LIMIT_EXCEEDED'))) body.details = rest;
  return { status, body };
}
