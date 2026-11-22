import type { PaymentMethod } from '../charges/charges.js';
import type { DomainEvent } from '../events/domain-event.js';
import type { CurrencyCode } from '../money/currency.js';
import type { ScenarioOutcome } from '../scenarios/scenario-rule.js';
import type { SandboxError } from '../shared/errors.js';
import type { Sandbox } from '../sandbox.js';
import type { AutoDisablePolicy } from '../webhooks/webhooks.js';

export type ProviderId = string;
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface AdapterRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
  readonly sandbox: Sandbox;
  /** The platform, or the connected account the caller is acting as. */
  readonly ownerId: string;
  readonly apiKey: string;
  readonly requestId: string;
  /** Outcome forced by the per-request scenario header, if any. */
  readonly scenarioOverride?: ScenarioOutcome;
}

export interface AdapterResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface RouteDefinition {
  readonly method: HttpMethod;
  /** Path relative to the adapter mount, with `:param` placeholders, e.g. `/v1/customers/:customer_id`. */
  readonly path: string;
  /** Stable operation name, used in logs. */
  readonly operation: string;
  /** Overrides the idempotency policy's method rule for this route. */
  readonly idempotent?: boolean;
  handler(request: AdapterRequest): AdapterResponse | Promise<AdapterResponse>;
}

export type AuthResult =
  | { readonly ok: true; readonly apiKey: string }
  | { readonly ok: false; readonly error: SandboxError };

export interface AuthPolicy {
  authenticate(headers: Readonly<Record<string, string | undefined>>): AuthResult;
  /** Header naming the connected account to act as, if the provider supports it. */
  readonly actingAccountHeader?: string;
}

export interface IdempotencyPolicy {
  readonly header: string;
  readonly methods: readonly HttpMethod[];
  readonly ttlMs: number;
}

export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
  readonly headers: { readonly limit: string; readonly remaining: string; readonly reset: string };
}

export interface WebhookSignInput {
  readonly rawBody: string;
  readonly timestamp: Date;
  /** Current secret first, then any previous secrets still valid after rotation. */
  readonly secrets: readonly string[];
}

export interface WebhookSigner {
  sign(input: WebhookSignInput): Readonly<Record<string, string>>;
}

export interface DeliveryResult {
  readonly status?: number;
  readonly error?: 'timeout' | 'connection_error' | string;
}

export interface DeliveryPolicy {
  /** Total attempts for automatic deliveries, including the first. */
  readonly maxAttempts: number;
  /** Wait before attempt n+2 (index 0 = wait after the first failure). */
  readonly retryDelaysMs: readonly number[];
  readonly timeoutMs: number;
  isSuccess(status: number): boolean;
  isRetryable(result: DeliveryResult): boolean;
  readonly autoDisable: AutoDisablePolicy;
}

export interface ProviderWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly ownerId: string;
  readonly createdAt: string;
  /** The full JSON body sent to the endpoint. */
  readonly body: Readonly<Record<string, unknown>>;
}

export interface ProviderErrorResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

/** What a tester enters on the simulated hosted checkout page. */
export interface SimulatedPaymentInput {
  readonly method: PaymentMethod['type'];
  readonly cardNumber?: string;
  /** For crypto: the amount actually sent, in minor units (to simulate under/overpayment). */
  readonly amountPaidMinor?: bigint;
}

export interface SimulatedPayment {
  readonly paymentMethod: PaymentMethod;
  readonly outcomeOverride?: ScenarioOutcome;
}

export interface TestCard {
  readonly number: string;
  readonly description: string;
}

export interface ProviderAdapter {
  readonly providerId: ProviderId;
  readonly displayName: string;
  /** Documented sandbox test values, shown on the hosted checkout page. */
  readonly testCards?: readonly TestCard[];
  /** Maps hosted-checkout input to a payment method and (for test cards) a forced outcome. */
  simulatePayment?(input: SimulatedPaymentInput, context: { readonly currency: CurrencyCode; readonly amountMinor: bigint }): SimulatedPayment;
  readonly routes: readonly RouteDefinition[];
  readonly auth: AuthPolicy;
  readonly idempotency: IdempotencyPolicy;
  readonly rateLimit: RateLimitPolicy;
  readonly webhookSigner: WebhookSigner;
  readonly deliveryPolicy: DeliveryPolicy;
  /** Header that carries the request id on every response. */
  readonly requestIdHeader: string;
  mapDomainEvent(event: DomainEvent, sandbox: Sandbox): readonly ProviderWebhookEvent[];
  renderError(error: SandboxError): ProviderErrorResponse;
}
