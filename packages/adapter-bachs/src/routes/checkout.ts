import { MINUTE, type CurrencyCode, type Money } from '@mockrail/core';
import { BACHS, PAYMENT_METHOD_TYPES } from '../constants.js';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { serializeCheckout, serializeCheckoutCreated } from '../view.js';
import { checkMetadata, created, ok, readTransferFields, route, viewOf, type RouteFactory } from './helpers.js';

const PRICE_TYPES = ['fixed', 'custom', 'free'] as const;

/** Corridors that can collect a given currency. */
function corridorsFor(currency: CurrencyCode): string[] {
  if (currency === 'USD') return ['USD_CARD', 'CRYPTO'];
  if (currency === 'NGN') return ['NGN_CARD', 'NGN_BANK_TRANSFER', 'CRYPTO'];
  return [`MOMO_${currency}`, 'CRYPTO'];
}

export const checkoutRoutes: RouteFactory = (options) => [
  route('POST', '/v1/checkout-sessions', 'checkout.create', (req) => {
    const sandbox = req.sandbox;
    const body = new BodyReader(req.body);

    // Exactly one pricing source: product_cart or pricing.
    const cartRaw = body.raw('product_cart');
    const pricing = body.object('pricing');
    if ((cartRaw === undefined || cartRaw === null) === !pricing) {
      throw bachsError('VALIDATION_ERROR', 400, 'Provide exactly one of product_cart or pricing.', { field: 'product_cart' });
    }

    let lineItems: { productId: string; quantity: number; amount: Money | null }[] = [];
    let adhoc: Money | null = null;
    if (cartRaw !== undefined && cartRaw !== null) {
      if (!Array.isArray(cartRaw) || cartRaw.length < 1 || cartRaw.length > BACHS.maxCartItems) {
        throw bachsError('VALIDATION_ERROR', 400, `product_cart must have 1 to ${BACHS.maxCartItems} items.`, { field: 'product_cart' });
      }
      lineItems = cartRaw.map((raw, i) => {
        const item = new BodyReader(raw, `product_cart[${i}].`);
        const productId = item.string('product_id', { required: true });
        const quantity = item.integer('quantity', { min: 1 }) ?? 1;
        const product = productId ? sandbox.products.find(productId) : null;
        const amount = product ? (item.amount('amount', product.price.currency) ?? null) : null;
        item.done();
        return { productId, quantity, amount };
      });
    } else if (pricing) {
      const currency = pricing.currency('currency', { required: true });
      const priceType = pricing.oneOf('price_type', PRICE_TYPES) ?? 'fixed';
      const amount = pricing.amount('amount', currency, { allowZero: true });
      const preset = pricing.amount('preset_amount', currency);
      if (priceType === 'fixed' && !amount) pricing.fail('amount', 'Required for a fixed price.');
      adhoc = priceType === 'free' ? { amountMinor: 0n, currency: currency ?? 'USD' } : (amount ?? preset ?? null);
      if (priceType === 'custom' && !adhoc) pricing.fail('amount', 'A custom price needs an amount or preset_amount in the sandbox.');
    }

    // customer: { customer_id } or { email, name, phone_number }
    const customer = body.object('customer');
    const customerId = customer?.string('customer_id');
    const customerEmail = customerId ? undefined : customer?.string('email', { required: true });
    const customerName = customerId ? undefined : customer?.nullableString('name');
    const customerPhone = customerId ? undefined : customer?.nullableString('phone_number');
    if (customerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customerEmail)) body.fail('customer.email', 'Enter a valid email address.');

    const successUrl = body.string('success_url') ?? body.string('return_url');
    const cancelUrl = body.string('cancel_url');
    for (const [field, value] of [['success_url', successUrl], ['cancel_url', cancelUrl]] as const) {
      if (value && !/^https?:\/\//.test(value)) body.fail(field, 'Must be a public http or https URL.');
    }
    const { min, max } = BACHS.checkoutExpiryMinutes;
    const expiresInMinutes = body.integer('expires_in_minutes', { min, max }) ?? BACHS.checkoutExpiryMinutes.default;
    const methodTypes = body.stringArray('payment_method_types');
    const reference = body.string('reference', { max: 128 });
    const metadata = body.metadata();
    const customerCreation = body.oneOf('customer_creation', ['always', 'if_required'] as const) ?? 'if_required';
    const savePaymentMethod = body.boolean('save_payment_method') ?? false;
    checkMetadata(metadata);

    const firstProduct = lineItems[0] ? sandbox.products.find(lineItems[0].productId) : null;
    const currency = (adhoc?.currency ?? firstProduct?.price.currency) as CurrencyCode | undefined;
    const transfer = readTransferFields(body, req, currency);

    // A recurring cart needs a customer; subscriptions are USD card only.
    const recurring = lineItems.map((l) => sandbox.products.find(l.productId)).find((p) => p?.recurring);
    if (recurring && !customerId && !customerEmail) {
      throw bachsError('VALIDATION_ERROR', 400, 'customer is required for a cart with a recurring product.', { field: 'customer' });
    }
    if (recurring && recurring.price.currency !== 'USD') {
      throw bachsError(recurring.price.currency === 'NGN' ? 'NGN_SUBSCRIPTIONS_NOT_AVAILABLE' : 'SUBSCRIPTION_METHOD_NOT_SUPPORTED', 403, 'Subscriptions are available for USD card payments only.');
    }

    let corridors = currency ? corridorsFor(currency) : [];
    if (recurring) corridors = ['USD_CARD'];
    if (methodTypes) {
      const unknown = methodTypes.filter((m) => !(PAYMENT_METHOD_TYPES as readonly string[]).includes(m.toUpperCase()));
      if (unknown.length) throw bachsError('PAYMENT_METHOD_NOT_ALLOWED', 400, `Unknown payment method types: ${unknown.join(', ')}.`, { field: 'payment_method_types' });
      const wanted = methodTypes.map((m) => m.toUpperCase());
      corridors = corridors.filter((c) => wanted.includes(c));
      if (!corridors.length) throw bachsError('CHECKOUT_RESTRICTION_LEAVES_NO_PAYMENT_METHOD', 400, 'The payment method restriction leaves nothing the customer can pay with.');
    }

    // The fee or fixed transfer must be less than the gross (INVALID_PLATFORM_FEE).
    const gross = adhoc?.amountMinor ?? lineItems.reduce((sum, l) => {
      const p = sandbox.products.find(l.productId);
      return sum + (l.amount?.amountMinor ?? p?.price.amountMinor ?? 0n) * BigInt(l.quantity);
    }, 0n);
    const term = transfer.platformFee ?? transfer.transferAmount;
    if (term && gross > 0n && term.amountMinor >= gross) {
      throw bachsError('INVALID_PLATFORM_FEE', 400, 'The platform fee or transfer amount must be less than the gross amount.', { field: 'platform_fee' });
    }

    const session = sandbox.checkout.create({
      ownerId: req.ownerId,
      ...(lineItems.length ? { lineItems } : { amount: adhoc }),
      customerId: customerId ?? null,
      customerEmail: customerEmail ?? null,
      customerName: customerName ?? null,
      customerPhone: customerPhone ?? null,
      customerCreation,
      savePaymentMethod,
      successUrl: successUrl ?? null,
      cancelUrl: cancelUrl ?? null,
      expiresInMs: expiresInMinutes * MINUTE,
      paymentMethodTypes: corridors,
      reference: reference ?? null,
      metadata: metadata ?? {},
      billingPolicy: {
        retryDelaysMs: BACHS.subscriptionRetryDelaysMs,
        exhaustedAction: options.keepUnpaidSubscriptions ? 'unpaid' : 'cancel',
      },
      ...transfer,
    });
    return created(serializeCheckoutCreated(session));
  }),

  route('GET', '/v1/checkout-sessions/:checkout_id', 'checkout.retrieve', (req) =>
    ok(serializeCheckout(viewOf(req, options), req.sandbox.checkout.get(req.ownerId, req.params.checkout_id ?? ''))),
  ),
];
