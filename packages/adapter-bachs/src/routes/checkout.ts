import { MINUTE } from '@mockrail/core';
import { BACHS } from '../constants.js';
import { BodyReader } from '../request.js';
import { serializeCheckout } from '../serializers.js';
import { created, ok, readTransferFields, route, type RouteFactory } from './helpers.js';

export const checkoutRoutes: RouteFactory = (options) => [
  route('POST', '/v1/checkout-sessions', 'checkout.create', (req) => {
    const body = new BodyReader(req.body);
    const productId = body.string('product_id');
    const currency = body.currency('currency', { required: !productId });
    const amount = productId ? undefined : body.amount('amount', currency, { required: true });
    const { min, max } = BACHS.checkoutExpiryMinutes;
    const expiresInMinutes = body.integer('expires_in_minutes', { min, max }) ?? BACHS.checkoutExpiryMinutes.default;
    const customerId = body.string('customer_id');
    const customerEmail = body.string('customer_email');
    const customerName = body.string('customer_name');
    const successUrl = body.string('success_url');
    const cancelUrl = body.string('cancel_url');
    const paymentMethods = body.stringArray('payment_methods');
    const reference = body.string('reference');
    const metadata = body.metadata();
    const transfer = readTransferFields(body, req, currency);

    const session = req.sandbox.checkout.create({
      ownerId: req.ownerId,
      productId: productId ?? null,
      amount: amount ?? null,
      customerId: customerId ?? null,
      customerEmail: customerEmail ?? null,
      customerName: customerName ?? null,
      successUrl: successUrl ?? null,
      cancelUrl: cancelUrl ?? null,
      expiresInMs: expiresInMinutes * MINUTE,
      paymentMethodTypes: paymentMethods ?? ['card'],
      reference: reference ?? null,
      metadata: metadata ?? {},
      billingPolicy: {
        retryDelaysMs: BACHS.subscriptionRetryDelaysMs,
        exhaustedAction: options.keepUnpaidSubscriptions ? 'unpaid' : 'cancel',
      },
      ...transfer,
    });
    return created(serializeCheckout(session, options.exposeUndocumentedCheckoutStatuses));
  }),

  route('GET', '/v1/checkout-sessions/:checkout_id', 'checkout.retrieve', (req) =>
    ok(serializeCheckout(req.sandbox.checkout.get(req.ownerId, req.params.checkout_id ?? ''), options.exposeUndocumentedCheckoutStatuses)),
  ),
];
