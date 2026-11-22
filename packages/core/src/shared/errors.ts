export type SandboxErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid_state'
  | 'idempotency_conflict'
  | 'idempotency_in_progress'
  | 'rate_limited'
  | 'insufficient_balance'
  | 'quote_expired'
  | 'recipient_incomplete'
  | 'refund_not_allowed'
  | 'internal';

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

const DEFAULT_STATUS: Readonly<Record<SandboxErrorCode, number>> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_state: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  rate_limited: 429,
  insufficient_balance: 400,
  quote_expired: 400,
  recipient_incomplete: 400,
  refund_not_allowed: 400,
  internal: 500,
};

export interface SandboxErrorOptions {
  readonly fieldErrors?: readonly FieldError[];
  readonly details?: Readonly<Record<string, unknown>>;
  readonly status?: number;
}

/** Provider-neutral error. Adapters render it into their own wire format. */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly status: number;
  readonly fieldErrors: readonly FieldError[];
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: SandboxErrorCode, message: string, options: SandboxErrorOptions = {}) {
    super(message);
    this.name = 'SandboxError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.fieldErrors = options.fieldErrors ?? [];
    this.details = options.details ?? {};
  }
}

export function notFound(resource: string, id: string): SandboxError {
  return new SandboxError('not_found', `No ${resource} found with id '${id}'.`, { details: { resource, id } });
}

export function validationFailed(fieldErrors: readonly FieldError[], message = 'The request failed validation.'): SandboxError {
  return new SandboxError('validation_failed', message, { fieldErrors });
}

export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof SandboxError;
}
