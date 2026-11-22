import type { ProviderAdapter } from '@mockrail/core';
import { bachsAuth } from './auth.js';
import { BACHS, TEST_CARDS } from './constants.js';
import { renderBachsError } from './errors.js';
import { createEventMapper } from './events.js';
import { resolveOptions, type BachsAdapterOptions } from './options.js';
import { balanceRoutes } from './routes/balances.js';
import { checkoutRoutes } from './routes/checkout.js';
import { connectRoutes } from './routes/connect.js';
import { customerRoutes } from './routes/customers.js';
import { paymentRoutes } from './routes/payments.js';
import { payoutRoutes } from './routes/payouts.js';
import { productRoutes } from './routes/products.js';
import { refundRoutes } from './routes/refunds.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { virtualAccountRoutes } from './routes/virtual-accounts.js';
import { webhookRoutes } from './routes/webhooks.js';
import { bachsDeliveryPolicy, bachsWebhookSigner } from './signer.js';
import { simulateBachsPayment } from './test-triggers.js';

export function createBachsAdapter(options: BachsAdapterOptions = {}): ProviderAdapter {
  const resolved = resolveOptions(options);
  const factories = [
    checkoutRoutes,
    paymentRoutes,
    customerRoutes,
    productRoutes,
    subscriptionRoutes,
    virtualAccountRoutes,
    refundRoutes,
    payoutRoutes,
    balanceRoutes,
    webhookRoutes,
    connectRoutes,
  ];
  return {
    providerId: BACHS.providerId,
    displayName: BACHS.displayName,
    routes: factories.flatMap((factory) => factory(resolved)),
    auth: bachsAuth,
    idempotency: { header: BACHS.idempotencyHeader, methods: ['POST', 'PATCH'], ttlMs: BACHS.idempotencyTtlMs },
    rateLimit: {
      limit: BACHS.sandboxRateLimitPerMinute,
      windowMs: 60_000,
      headers: { limit: 'X-RateLimit-Limit', remaining: 'X-RateLimit-Remaining', reset: 'X-RateLimit-Reset' },
    },
    requestIdHeader: 'x-request-id',
    webhookSigner: bachsWebhookSigner,
    deliveryPolicy: bachsDeliveryPolicy,
    testCards: TEST_CARDS.map((c) => ({ number: c.number, description: c.description })),
    simulatePayment: simulateBachsPayment,
    mapDomainEvent: createEventMapper(resolved),
    renderError: renderBachsError,
  };
}

/** Default instance; servers load this when `providers` includes "bachs". */
export const adapter = createBachsAdapter();
export default adapter;

export { BACHS, PAYOUT_TRIGGERS, TEST_CARDS } from './constants.js';
export { ERROR_CODES, renderBachsError } from './errors.js';
export { BACHS_EVENT_TYPES, type BachsEventType } from './events.js';
export { formatAmount } from './money.js';
export type { BachsAdapterOptions } from './options.js';
export { paginate, type BachsList, type BachsPagination } from './pagination.js';
export { BACHS_HEADERS, bachsDeliveryPolicy, bachsWebhookSigner, computeBachsSignature, verifyBachsSignature } from './signer.js';
export { outcomeForCard, outcomeForDestination } from './test-triggers.js';
