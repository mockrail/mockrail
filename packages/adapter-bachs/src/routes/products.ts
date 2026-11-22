import type { Cadence, CurrencyCode, CustomPriceBounds, Money, PriceType } from '@mockrail/core';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { serializeProduct } from '../view.js';
import { checkMetadata, created, list, ok, route, viewOf, type RouteFactory } from './helpers.js';

const INTERVALS = ['day', 'week', 'month', 'year'] as const;
const PRODUCT_CURRENCIES = ['USD', 'NGN', 'GHS', 'KES', 'MWK', 'RWF', 'TZS', 'UGX', 'XAF', 'XOF', 'ZMW'];

function readCadence(body: BodyReader, field: string): Cadence | null | undefined {
  if (body.raw(field) === null) return null;
  const c = body.object(field);
  if (!c) return undefined;
  const interval = c.oneOf('interval', INTERVALS, { required: true });
  const frequency = c.integer('frequency', { min: 1 });
  if (frequency === undefined) c.fail('frequency', 'This field is required.');
  return interval && frequency ? { interval, intervalCount: frequency } : undefined;
}

function readCurrencyOptions(body: BodyReader, primary: CurrencyCode | undefined): Money[] | undefined {
  const raw = body.raw('currency_options');
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    body.fail('currency_options', 'Must be an array.');
    return undefined;
  }
  const seen = new Set<string>();
  return raw.flatMap((item, i) => {
    const o = new BodyReader(item, `price.currency_options[${i}].`);
    const currency = o.currency('currency', { required: true });
    const amount = o.amount('amount', currency, { required: true });
    o.done();
    if (!currency || !amount) return [];
    if (currency === primary || seen.has(currency)) throw bachsError('DUPLICATE_CURRENCY', 400, `${currency} appears more than once.`, { field: `price.currency_options[${i}].currency` });
    seen.add(currency);
    return [amount];
  });
}

export const productRoutes: RouteFactory = (options) => [
  route('POST', '/v1/products', 'products.create', (req) => {
    const body = new BodyReader(req.body);
    const name = body.string('name', { required: true, max: 255 });
    const description = body.nullableString('description');
    if (description && description.length > 5000) body.fail('description', 'Must be at most 5000 characters.');
    const metadata = body.metadata();
    const billingCycle = readCadence(body, 'billing_cycle');
    const trial = readCadence(body, 'trial_period');
    const price = body.object('price');
    if (!price) body.fail('price', 'This field is required.');
    const rawCurrency = price?.raw('currency');
    if (typeof rawCurrency === 'string' && !PRODUCT_CURRENCIES.includes(rawCurrency.toUpperCase())) {
      throw bachsError('UNSUPPORTED_CURRENCY', 400, `Products cannot be priced in ${rawCurrency}.`, { field: 'price.currency' });
    }
    const currency = price?.currency('currency', { required: true });
    const priceType: PriceType = price?.oneOf('price_type', ['fixed', 'free', 'custom'] as const) ?? 'fixed';
    const amount = price?.amount('amount', currency, { allowZero: false });
    const bounds: CustomPriceBounds = {
      preset: price?.amount('preset_amount', currency) ?? null,
      minimum: price?.amount('minimum_amount', currency) ?? null,
      maximum: price?.amount('maximum_amount', currency) ?? null,
    };
    if (priceType === 'fixed' && !amount && price?.raw('amount') === undefined) throw bachsError('PRICE_REQUIRED', 400, 'A fixed price needs an amount.', { field: 'price.amount' });
    const currencyOptions = price ? readCurrencyOptions(price, currency) : undefined;
    body.done();
    checkMetadata(metadata);
    if (trial && !billingCycle) throw bachsError('TRIAL_REQUIRES_RECURRING', 400, 'trial_period is only valid on a recurring product.', { field: 'trial_period' });

    const product = req.sandbox.products.create({
      ownerId: req.ownerId,
      name,
      description: description ?? null,
      priceType,
      price: priceType === 'fixed' ? amount! : { amountMinor: 0n, currency: currency! },
      customBounds: priceType === 'custom' ? bounds : null,
      currencyOptions: currencyOptions ?? [],
      recurring: billingCycle ? { ...billingCycle, trial: trial ?? null } : null,
      metadata: metadata ?? {},
    });
    return created(serializeProduct(viewOf(req, options), product));
  }),

  route('GET', '/v1/products', 'products.list', (req) => {
    const view = viewOf(req, options);
    return list(req, req.sandbox.products.list(req.ownerId, { includeArchived: req.query.include_archived === 'true' }), (p) => serializeProduct(view, p), 20);
  }),

  route('GET', '/v1/products/:product_id', 'products.retrieve', (req) => ok(serializeProduct(viewOf(req, options), req.sandbox.products.get(req.ownerId, req.params.product_id ?? '')))),

  route('PATCH', '/v1/products/:product_id', 'products.update', (req) => {
    const current = req.sandbox.products.get(req.ownerId, req.params.product_id ?? '');
    const body = new BodyReader(req.body);
    const name = body.string('name', { max: 255 });
    const description = body.nullableString('description');
    const metadata = body.metadata();
    const billingCycle = readCadence(body, 'billing_cycle');
    const trial = readCadence(body, 'trial_period');
    const price = body.object('price');
    const amount = price?.amount('amount', current.price.currency);
    const currencyOptions = price ? readCurrencyOptions(price, current.price.currency) : undefined;
    body.done();
    checkMetadata(metadata);
    if (amount && current.priceType !== 'fixed') throw bachsError('VALIDATION_ERROR', 400, 'Only fixed-price products take a new amount.', { field: 'price.amount' });
    if (billingCycle && current.recurring && (billingCycle.interval !== current.recurring.interval || billingCycle.intervalCount !== current.recurring.intervalCount)) {
      throw bachsError('RECURRING_INTERVAL_IMMUTABLE', 400, 'The billing cycle cannot change once set. Create a new product instead.', { field: 'billing_cycle' });
    }
    const base = billingCycle ?? current.recurring;
    if (trial && !base) throw bachsError('TRIAL_REQUIRES_RECURRING', 400, 'trial_period is only valid on a recurring product.', { field: 'trial_period' });
    const product = req.sandbox.products.update(req.ownerId, current.id, {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(amount ? { price: amount } : {}),
      ...(currencyOptions ? { currencyOptions } : {}),
      ...(base && (billingCycle || trial !== undefined) ? { recurring: { interval: base.interval, intervalCount: base.intervalCount, trial: trial !== undefined ? trial : (current.recurring?.trial ?? null) } } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return ok(serializeProduct(viewOf(req, options), product));
  }),

  route('POST', '/v1/products/:product_id/archive', 'products.archive', (req) =>
    ok(serializeProduct(viewOf(req, options), req.sandbox.products.setArchived(req.ownerId, req.params.product_id ?? '', true))),
  ),

  route('POST', '/v1/products/:product_id/unarchive', 'products.unarchive', (req) =>
    ok(serializeProduct(viewOf(req, options), req.sandbox.products.setArchived(req.ownerId, req.params.product_id ?? '', false))),
  ),
];
