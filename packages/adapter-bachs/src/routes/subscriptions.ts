import type { SubscriptionStatus } from '@mockrail/core';
import { BodyReader } from '../request.js';
import { serializeSubscription } from '../serializers.js';
import { list, ok, route, type RouteFactory } from './helpers.js';

const STATUSES: readonly SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'unpaid', 'canceled'];

/** Subscriptions are created only by completing a checkout for a recurring product, so there is no POST. */
export const subscriptionRoutes: RouteFactory = () => [
  route('GET', '/v1/subscriptions', 'subscriptions.list', (req) => {
    const status = STATUSES.find((s) => s === req.query.status);
    return list(
      req,
      req.sandbox.subscriptions.list(req.ownerId, {
        ...(status ? { status } : {}),
        ...(req.query.customer_id ? { customerId: req.query.customer_id } : {}),
      }),
      serializeSubscription,
    );
  }),

  route('GET', '/v1/subscriptions/:subscription_id', 'subscriptions.retrieve', (req) =>
    ok(serializeSubscription(req.sandbox.subscriptions.get(req.ownerId, req.params.subscription_id ?? ''))),
  ),

  route('PATCH', '/v1/subscriptions/:subscription_id', 'subscriptions.update', (req) => {
    const body = new BodyReader(req.body);
    const cancelAtPeriodEnd = body.boolean('cancel_at_period_end');
    const metadata = body.metadata();
    body.done();
    const subscription = req.sandbox.subscriptions.update(req.ownerId, req.params.subscription_id ?? '', {
      ...(cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return ok(serializeSubscription(subscription));
  }),

  route('DELETE', '/v1/subscriptions/:subscription_id', 'subscriptions.cancel', (req) =>
    ok(serializeSubscription(req.sandbox.subscriptions.cancel(req.ownerId, req.params.subscription_id ?? ''))),
  ),
];
