import { BodyReader } from '../request.js';
import { serializeCustomer } from '../serializers.js';
import { created, list, ok, route, type RouteFactory } from './helpers.js';

export const customerRoutes: RouteFactory = () => [
  route('POST', '/v1/customers', 'customers.create', (req) => {
    const body = new BodyReader(req.body);
    const input = {
      email: body.string('email', { max: 320 }) ?? null,
      name: body.string('name', { max: 200 }) ?? null,
      phone: body.string('phone', { max: 40 }) ?? null,
      metadata: body.metadata() ?? {},
    };
    body.done();
    return created(serializeCustomer(req.sandbox.customers.create({ ownerId: req.ownerId, ...input })));
  }),

  route('GET', '/v1/customers', 'customers.list', (req) =>
    list(req, req.sandbox.customers.list(req.ownerId, req.query.email ? { email: req.query.email } : {}), serializeCustomer),
  ),

  route('GET', '/v1/customers/:customer_id', 'customers.retrieve', (req) =>
    ok(serializeCustomer(req.sandbox.customers.get(req.ownerId, req.params.customer_id ?? ''))),
  ),

  route('PATCH', '/v1/customers/:customer_id', 'customers.update', (req) => {
    const body = new BodyReader(req.body);
    const email = body.nullableString('email');
    const name = body.nullableString('name');
    const phone = body.nullableString('phone');
    const metadata = body.metadata();
    body.done();
    const customer = req.sandbox.customers.update(req.ownerId, req.params.customer_id ?? '', {
      ...(email !== undefined ? { email } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return ok(serializeCustomer(customer));
  }),
];
