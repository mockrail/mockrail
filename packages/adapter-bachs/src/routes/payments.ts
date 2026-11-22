import type { ChargeStatus, PaymentMethod } from '@mockrail/core';
import { BodyReader } from '../request.js';
import { serializePayment } from '../serializers.js';
import { chargeStatus, paymentTypeFilter } from '../statuses.js';
import { cardPaymentMethod, outcomeForCard } from '../test-triggers.js';
import { created, list, ok, readTransferFields, route, type RouteFactory } from './helpers.js';

const CORE_STATUS_FILTER: Readonly<Record<string, ChargeStatus>> = {
  open: 'pending',
  succeeded: 'succeeded',
  underpaid: 'underpaid',
  overpaid: 'overpaid',
  failed: 'failed',
};

export const paymentRoutes: RouteFactory = () => [
  route('GET', '/v1/payments', 'payments.list', (req) => {
    const status = req.query.status;
    const paymentMethodType = paymentTypeFilter(req.query.payment_type);
    let items = req.sandbox.charges.list(req.ownerId, {
      ...(req.query.customer_id ? { customerId: req.query.customer_id } : {}),
      ...(req.query.checkout_id ? { checkoutId: req.query.checkout_id } : {}),
      ...(paymentMethodType ? { paymentMethodType } : {}),
      ...(status && CORE_STATUS_FILTER[status] ? { status: CORE_STATUS_FILTER[status] } : {}),
    });
    // Refund-derived statuses are computed, so filter on the rendered status.
    if (status && !CORE_STATUS_FILTER[status]) items = items.filter((c) => chargeStatus(c).status === status);
    return list(req, items, serializePayment);
  }),

  route('GET', '/v1/payments/:payment_id', 'payments.retrieve', (req) =>
    ok(serializePayment(req.sandbox.charges.get(req.ownerId, req.params.payment_id ?? ''))),
  ),

  route('POST', '/v1/charges', 'charges.create', (req) => {
    const body = new BodyReader(req.body);
    const currency = body.currency('currency', { required: true });
    const amount = body.amount('amount', currency, { required: true });
    const customerId = body.string('customer_id');
    const description = body.string('description');
    const reference = body.string('reference');
    const metadata = body.metadata();
    const methodType = body.oneOf('payment_method', ['card', 'bank_transfer', 'crypto', 'mobile_money'] as const) ?? 'card';
    const card = body.object('card');
    // Without a card number the charge uses a default card that succeeds.
    const cardNumber = card?.string('number');
    const transfer = readTransferFields(body, req, currency);

    if (customerId) req.sandbox.customers.get(req.ownerId, customerId);
    const paymentMethod: PaymentMethod =
      methodType === 'card'
        ? cardPaymentMethod(cardNumber)
        : methodType === 'bank_transfer'
          ? { type: 'bank_transfer', senderName: null, senderAccountNumber: null, senderBankName: null }
          : methodType === 'crypto'
            ? { type: 'crypto', network: null, asset: null }
            : { type: 'mobile_money', phone: null, provider: null };
    const outcomeOverride = req.scenarioOverride ?? (methodType === 'card' ? outcomeForCard(cardNumber) : undefined);

    const charge = req.sandbox.charges.create({
      ownerId: req.ownerId,
      amount: amount!,
      customerId: customerId ?? null,
      paymentMethod,
      description: description ?? null,
      reference: reference ?? null,
      metadata: metadata ?? {},
      ...transfer,
      ...(outcomeOverride ? { outcomeOverride } : {}),
    });
    return created(serializePayment(charge));
  }),
];
