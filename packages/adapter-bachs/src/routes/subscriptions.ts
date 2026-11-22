import type { AdapterRequest, ProrationBehavior, SubscriptionStatus } from '@mockrail/core';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { serializeSubscription } from '../view.js';
import { list, ok, route, viewOf, type RouteFactory } from './helpers.js';

const STATUSES: readonly SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'unpaid', 'canceled'];
const INTENTS = ['product_id', 'seats', 'trial_end', 'payment_method_id', 'metadata'] as const;

function getSubscription(req: AdapterRequest) {
  const id = req.params.subscription_id ?? '';
  const s = req.sandbox.subscriptions.find(id);
  if (!s || s.ownerId !== req.ownerId) throw bachsError('SUBSCRIPTION_NOT_FOUND', 404, `No subscription found with id '${id}'.`);
  return s;
}

/** Subscriptions are created only by completing a checkout for a recurring product, so there is no POST. */
export const subscriptionRoutes: RouteFactory = (options) => [
  route('GET', '/v1/subscriptions', 'subscriptions.list', (req) => {
    const view = viewOf(req, options);
    const status = req.query.status;
    if (status && !STATUSES.includes(status as SubscriptionStatus)) throw bachsError('VALIDATION_ERROR', 400, `status must be one of: ${STATUSES.join(', ')}.`, { field: 'status' });
    const items = req.sandbox.subscriptions.list(req.ownerId, {
      ...(status ? { status: status as SubscriptionStatus } : {}),
      ...(req.query.customer_id ? { customerId: req.query.customer_id } : {}),
    });
    return list(req, items, (s) => serializeSubscription(view, s), 50);
  }),

  route('GET', '/v1/subscriptions/:subscription_id', 'subscriptions.retrieve', (req) => ok(serializeSubscription(viewOf(req, options), getSubscription(req)))),

  /** One intent per request: change the plan or seats, move the trial, swap the payment method, or edit metadata. */
  route('PATCH', '/v1/subscriptions/:subscription_id', 'subscriptions.update', (req) => {
    const current = getSubscription(req);
    const sandbox = req.sandbox;
    const body = new BodyReader(req.body);
    const sent = INTENTS.filter((k) => body.has(k));
    if (sent.length !== 1) throw bachsError('BAD_REQUEST', 400, sent.length ? `Send exactly one change per request (got ${sent.join(', ')}).` : 'Nothing to update.');
    const proration = (body.oneOf('proration_behavior', ['invoice_now', 'next_cycle', 'none'] as const) ?? 'invoice_now') as ProrationBehavior;
    const view = viewOf(req, options);

    switch (sent[0]) {
      case 'product_id': {
        const productId = body.string('product_id', { required: true, max: 64 });
        body.done();
        const product = sandbox.products.find(productId);
        if (!product || product.ownerId !== req.ownerId) throw bachsError('PRODUCT_NOT_FOUND', 400, `No product found with id '${productId}'.`);
        if (!product.recurring) throw bachsError('SUBSCRIPTION_PRICE_NOT_RECURRING', 400, 'The new product is not recurring.');
        const price = sandbox.products.priceIn(product, current.unitAmount.currency);
        if (!price) throw bachsError('PLAN_NOT_PRICED_IN_CURRENCY', 400, `The product is not priced in ${current.unitAmount.currency}.`);
        return ok(serializeSubscription(view, sandbox.subscriptions.changePlan(req.ownerId, current.id, { productId: product.id, unitAmount: price, recurring: product.recurring, proration })));
      }
      case 'seats': {
        const seats = body.integer('seats', { min: 1 });
        const itemId = body.string('subscription_item_id', { max: 64 });
        body.done();
        if (itemId && itemId !== current.itemId) throw bachsError('SUBSCRIPTION_ITEM_NOT_FOUND', 404, `No subscription item '${itemId}'.`);
        return ok(serializeSubscription(view, sandbox.subscriptions.changePlan(req.ownerId, current.id, { quantity: seats!, proration })));
      }
      case 'trial_end': {
        const raw = body.string('trial_end', { required: true });
        body.done();
        const at = new Date(raw);
        if (Number.isNaN(at.getTime())) throw bachsError('VALIDATION_ERROR', 400, 'trial_end must be an ISO 8601 date-time.', { field: 'trial_end' });
        return ok(serializeSubscription(view, sandbox.subscriptions.setTrialEnd(req.ownerId, current.id, at)));
      }
      case 'payment_method_id': {
        const pmId = body.string('payment_method_id', { required: true, max: 64 });
        body.done();
        const pm = sandbox.customers.findPaymentMethod(pmId);
        if (!pm || pm.ownerId !== req.ownerId || pm.customerId !== current.customerId) throw bachsError('SAVED_PAYMENT_METHOD_NOT_FOUND', 404, `No saved payment method '${pmId}' for this customer.`);
        return ok(serializeSubscription(view, sandbox.subscriptions.setPaymentMethod(req.ownerId, current.id, pm.id)));
      }
      default: {
        // metadata: an object (empty-string values remove keys) or "" to clear everything.
        const raw = body.raw('metadata');
        if (raw === '') return ok(serializeSubscription(view, sandbox.subscriptions.updateMetadata(req.ownerId, current.id, null)));
        const metadata = body.metadata();
        body.done();
        if (metadata && Object.keys(metadata).length > 20) throw bachsError('METADATA_LIMIT_EXCEEDED', 400, 'Metadata can have at most 20 keys.', { field: 'metadata' });
        return ok(serializeSubscription(view, sandbox.subscriptions.updateMetadata(req.ownerId, current.id, metadata ?? {})));
      }
    }
  }),

  /** Cancels now, or at current_period_end with cancel_at_period_end: true. */
  route('DELETE', '/v1/subscriptions/:subscription_id', 'subscriptions.cancel', (req) => {
    const current = getSubscription(req);
    const body = new BodyReader(req.body);
    const atPeriodEnd = body.boolean('cancel_at_period_end') ?? false;
    const reason = body.nullableString('reason');
    body.done();
    return ok(serializeSubscription(viewOf(req, options), req.sandbox.subscriptions.cancel(req.ownerId, current.id, { atPeriodEnd, reason: reason ?? null })));
  }),
];
