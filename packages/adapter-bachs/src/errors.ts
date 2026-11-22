import type { ProviderErrorResponse, SandboxError, SandboxErrorCode } from '@mockrail/core';

/**
 * Core error code -> Bachs `error_code`. Codes marked documented appear in the Bachs docs;
 * the rest are best guesses until confirmed (see UNVERIFIED.md).
 */
export const ERROR_CODES: Readonly<Record<SandboxErrorCode, { readonly code: string; readonly documented: boolean }>> = {
  bad_request: { code: 'BAD_REQUEST', documented: true },
  validation_failed: { code: 'VALIDATION_ERROR', documented: false },
  unauthorized: { code: 'UNAUTHORIZED', documented: false },
  forbidden: { code: 'FORBIDDEN', documented: false },
  not_found: { code: 'NOT_FOUND', documented: false },
  conflict: { code: 'CONFLICT', documented: false },
  invalid_state: { code: 'INVALID_STATE', documented: false },
  idempotency_conflict: { code: 'IDEMPOTENCY_CONFLICT', documented: true },
  idempotency_in_progress: { code: 'IDEMPOTENCY_IN_PROGRESS', documented: true },
  rate_limited: { code: 'RATE_LIMITED', documented: false },
  insufficient_balance: { code: 'INSUFFICIENT_BALANCE', documented: false },
  quote_expired: { code: 'QUOTE_EXPIRED', documented: false },
  recipient_incomplete: { code: 'PAYOUT_RECIPIENT_INCOMPLETE', documented: true },
  refund_not_allowed: { code: 'REFUND_NOT_ALLOWED', documented: false },
  internal: { code: 'INTERNAL_ERROR', documented: false },
};

/** Bachs errors are a flat object: error_code, detail, optional doc_url, errors[], details. */
export function renderBachsError(error: SandboxError): ProviderErrorResponse {
  const mapped = ERROR_CODES[error.code];
  return {
    status: error.status,
    body: {
      error_code: mapped.code,
      detail: error.message,
      doc_url: 'https://docs.bachs.io/errors',
      errors: error.fieldErrors.map((e) => ({ field: e.field, message: e.message })),
      details: error.details,
    },
  };
}
