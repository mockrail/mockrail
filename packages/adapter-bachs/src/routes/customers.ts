import type { Address } from '@mockrail/core';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { serializeCustomer, serializeCustomerListItem } from '../view.js';
import { checkMetadata, created, list, ok, route, type RouteFactory } from './helpers.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * billing_address: omitted = untouched, null = cleared, object = full replacement. line1 and a
 * two-letter country are required whenever an address is supplied; {} is rejected.
 */
function readAddress(body: BodyReader): Address | null | undefined {
  const raw = body.raw('billing_address');
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const a = body.object('billing_address');
  if (!a) return undefined;
  if (typeof raw === 'object' && Object.keys(raw as object).length === 0) {
    body.fail('billing_address', 'An empty address is not allowed. Send null to clear it.');
    return undefined;
  }
  const country = a.string('country', { required: true });
  if (country && !/^[A-Za-z]{2}$/.test(country)) a.fail('country', 'Must be an ISO 3166-1 alpha-2 code.');
  return {
    line1: a.string('line1', { required: true, max: 255 }) ?? null,
    line2: a.nullableString('line2') ?? null,
    city: a.nullableString('city') ?? null,
    state: a.nullableString('state') ?? null,
    postalCode: a.nullableString('postal_code') ?? null,
    country: country?.toUpperCase() ?? null,
  };
}

export const customerRoutes: RouteFactory = () => [
  /** Creating with an existing email returns that customer with the changes applied (customer.updated). */
  route('POST', '/v1/customers', 'customers.create', (req) => {
    const body = new BodyReader(req.body);
    const email = body.string('email', { required: true });
    if (email && !EMAIL.test(email)) body.fail('email', 'Enter a valid email address.');
    const name = body.nullableString('name');
    if (name && name.length > 511) body.fail('name', 'Must be at most 511 characters.');
    const phone = body.nullableString('phone_number');
    const metadata = body.metadata();
    const billingAddress = readAddress(body);
    body.done();
    checkMetadata(metadata);
    const { customer } = req.sandbox.customers.upsertByEmail({
      ownerId: req.ownerId,
      email,
      ...(name !== undefined ? { name } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(billingAddress !== undefined ? { billingAddress } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return created(serializeCustomer(customer));
  }),

  route('GET', '/v1/customers', 'customers.list', (req) =>
    list(req, req.sandbox.customers.list(req.ownerId, req.query.search ? { search: req.query.search } : {}), serializeCustomerListItem, 50),
  ),

  route('GET', '/v1/customers/:customer_id', 'customers.retrieve', (req) => ok(serializeCustomer(req.sandbox.customers.get(req.ownerId, req.params.customer_id ?? '')))),

  route('PATCH', '/v1/customers/:customer_id', 'customers.update', (req) => {
    const body = new BodyReader(req.body);
    const email = body.nullableString('email');
    if (email && !EMAIL.test(email)) body.fail('email', 'Enter a valid email address.');
    if (email === null) throw bachsError('VALIDATION_ERROR', 400, 'email cannot be cleared.', { field: 'email' });
    const name = body.nullableString('name');
    const phone = body.nullableString('phone_number');
    const metadata = body.metadata();
    const billingAddress = readAddress(body);
    body.done();
    checkMetadata(metadata);
    const customer = req.sandbox.customers.update(req.ownerId, req.params.customer_id ?? '', {
      ...(email !== undefined ? { email } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(billingAddress !== undefined ? { billingAddress } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return ok(serializeCustomer(customer));
  }),
];
