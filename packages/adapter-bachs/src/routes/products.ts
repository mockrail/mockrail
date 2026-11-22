import type { Recurring } from '@mockrail/core';
import { BodyReader } from '../request.js';
import { serializeProduct } from '../serializers.js';
import { created, list, ok, route, type RouteFactory } from './helpers.js';

const INTERVALS = ['day', 'week', 'month', 'year'] as const;

function readRecurring(body: BodyReader): Recurring | null | undefined {
  const recurring = body.object('recurring');
  if (!recurring) return body.raw('recurring') === null ? null : undefined;
  const interval = recurring.oneOf('interval', INTERVALS, { required: true });
  const intervalCount = recurring.integer('interval_count', { min: 1 }) ?? 1;
  const trialDays = recurring.integer('trial_days', { min: 0 }) ?? 0;
  return interval ? { interval, intervalCount, trialDays } : undefined;
}

export const productRoutes: RouteFactory = () => [
  route('POST', '/v1/products', 'products.create', (req) => {
    const body = new BodyReader(req.body);
    const name = body.string('name', { required: true, max: 250 });
    const description = body.string('description', { max: 5000 });
    const currency = body.currency('currency', { required: true });
    const price = body.amount('price', currency, { required: true, allowZero: true });
    const recurring = readRecurring(body);
    const metadata = body.metadata();
    body.done();
    const product = req.sandbox.products.create({
      ownerId: req.ownerId,
      name,
      description: description ?? null,
      price: price!,
      recurring: recurring ?? null,
      metadata: metadata ?? {},
    });
    return created(serializeProduct(product));
  }),

  route('GET', '/v1/products', 'products.list', (req) => {
    const archived = req.query.archived === undefined ? undefined : req.query.archived === 'true';
    return list(req, req.sandbox.products.list(req.ownerId, archived === undefined ? {} : { archived }), serializeProduct);
  }),

  route('GET', '/v1/products/:product_id', 'products.retrieve', (req) =>
    ok(serializeProduct(req.sandbox.products.get(req.ownerId, req.params.product_id ?? ''))),
  ),

  route('PATCH', '/v1/products/:product_id', 'products.update', (req) => {
    const current = req.sandbox.products.get(req.ownerId, req.params.product_id ?? '');
    const body = new BodyReader(req.body);
    const name = body.string('name', { max: 250 });
    const description = body.nullableString('description');
    const price = body.amount('price', current.price.currency, { allowZero: true });
    const metadata = body.metadata();
    body.done();
    const product = req.sandbox.products.update(req.ownerId, current.id, {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(price ? { price } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return ok(serializeProduct(product));
  }),

  route('POST', '/v1/products/:product_id/archive', 'products.archive', (req) =>
    ok(serializeProduct(req.sandbox.products.setArchived(req.ownerId, req.params.product_id ?? '', true))),
  ),

  route('POST', '/v1/products/:product_id/unarchive', 'products.unarchive', (req) =>
    ok(serializeProduct(req.sandbox.products.setArchived(req.ownerId, req.params.product_id ?? '', false))),
  ),
];
