import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { collectionFee } from '../test-triggers.js';
import { paymentStatus, serializePayment, serializePaymentListItem } from '../view.js';
import { checkMetadata, created, list, ok, route, viewOf, type RouteFactory } from './helpers.js';

const STATUS_FILTER = ['created', 'processing', 'succeeded', 'accepted', 'failed', 'expired', 'cancelled', 'refunded', 'partially_refunded', 'auto_refunded', 'underpaid', 'overpaid'];

export const paymentRoutes: RouteFactory = (options) => [
  route('GET', '/v1/payments', 'payments.list', (req) => {
    const view = viewOf(req, options);
    const status = req.query.status_filter;
    if (status && !STATUS_FILTER.includes(status)) throw bachsError('VALIDATION_ERROR', 400, `status_filter must be one of: ${STATUS_FILTER.join(', ')}.`, { field: 'status_filter' });
    let items = req.sandbox.charges.list(req.ownerId);
    if (status) items = items.filter((c) => paymentStatus(view, c) === status);
    return list(req, items, (c) => serializePaymentListItem(view, c), 50);
  }),

  route('GET', '/v1/payments/:payment_id', 'payments.retrieve', (req) =>
    ok(serializePayment(viewOf(req, options), req.sandbox.charges.get(req.ownerId, req.params.payment_id ?? ''))),
  ),

  /** Charges a customer's saved card off-session. A refused card is not an error: it returns 201 and then fails. */
  route('POST', '/v1/charges', 'charges.create', (req) => {
    const sandbox = req.sandbox;
    const body = new BodyReader(req.body);
    const customerId = body.string('customer', { required: true });
    const paymentMethodId = body.string('payment_method');
    const currency = body.currency('currency', { required: true });
    const amount = body.amount('amount', currency, { required: true });
    const description = body.string('description', { max: 255 });
    const reference = body.string('reference', { max: 128 });
    const metadata = body.metadata();
    body.done();
    checkMetadata(metadata);

    const customer = sandbox.customers.get(req.ownerId, customerId);
    const saved = sandbox.customers.listPaymentMethods(req.ownerId, customer.id);
    if (!saved.length) throw bachsError('NO_SAVED_PAYMENT_METHOD', 400, 'This customer has no saved payment method.');
    const pm = paymentMethodId ? saved.find((p) => p.id === paymentMethodId) : sandbox.customers.defaultPaymentMethod(req.ownerId, customer.id);
    if (!pm) throw bachsError('SAVED_PAYMENT_METHOD_NOT_FOUND', 404, `No saved payment method '${paymentMethodId}' for this customer.`);
    if (pm.method.type !== 'card') throw bachsError('PAYMENT_METHOD_UNUSABLE', 400, 'Only saved cards can be charged off-session.');
    if (currency !== 'USD' && currency !== 'NGN') throw bachsError('PAYMENT_METHOD_NOT_ENABLED', 400, `Card collection is not enabled in ${currency}.`);

    const outcomeOverride = req.scenarioOverride ?? pm.forcedOutcome ?? undefined;
    {
      const charge = sandbox.charges.create({
        ownerId: req.ownerId,
        amount: amount!,
        customerId: customer.id,
        paymentMethod: pm.method,
        savedPaymentMethodId: pm.id,
        feeRule: collectionFee('card', currency!),
        description: description ?? null,
        reference: reference ?? null,
        metadata: metadata ?? {},
        ...(outcomeOverride ? { outcomeOverride } : {}),
      });
      return created(serializePayment(viewOf(req, options), charge));
    }
  }),
];
