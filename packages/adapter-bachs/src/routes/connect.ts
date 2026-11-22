import { MINUTE, PLATFORM_OWNER, SandboxError, type AdapterRequest, type CapabilityStatus, type ConnectedAccount, type PersonInput } from '@mockrail/core';
import { AUTO_GRANTED_CAPABILITIES } from '../constants.js';
import { BodyReader } from '../request.js';
import { serializeAccount, serializeDocument, serializePerson, serializePlatformFee, serializeTransfer } from '../serializers.js';
import { created, list, ok, route, type RouteFactory } from './helpers.js';

const REQUIRED_FIELDS = ['email', 'country', 'business_name'] as const;

function requestedCapabilities(body: BodyReader): string[] {
  const raw = body.raw('capabilities');
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw) && raw.every((c) => typeof c === 'string')) return raw as string[];
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => v === true || (typeof v === 'object' && v !== null && (v as { requested?: unknown }).requested === true))
      .map(([k]) => k);
  }
  body.fail('capabilities', 'Use an array of capability names or { name: { requested: true } }.');
  return [];
}

function missingRequirements(account: Pick<ConnectedAccount, 'email' | 'country' | 'businessName'>): string[] {
  const values: Record<(typeof REQUIRED_FIELDS)[number], string | null> = {
    email: account.email,
    country: account.country,
    business_name: account.businessName,
  };
  return REQUIRED_FIELDS.filter((f) => !values[f]);
}

function readPerson(body: BodyReader): PersonInput {
  const firstName = body.nullableString('first_name');
  const lastName = body.nullableString('last_name');
  const email = body.nullableString('email');
  const phone = body.nullableString('phone');
  const roles = body.stringArray('roles');
  const metadata = body.metadata();
  return {
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(roles ? { roles } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

/** Connect management is a platform operation. */
function platformOnly(req: AdapterRequest): void {
  if (req.ownerId !== PLATFORM_OWNER) throw new SandboxError('forbidden', 'This endpoint is only available to the platform, not while acting as an account.');
}

function accountId(req: AdapterRequest): string {
  platformOnly(req);
  return req.params.account_id ?? '';
}

export const connectRoutes: RouteFactory = () => [
  route('POST', '/v1/accounts', 'accounts.create', (req) => {
    platformOnly(req);
    const body = new BodyReader(req.body);
    const fields = {
      type: body.string('type') ?? 'standard',
      email: body.string('email') ?? null,
      country: body.string('country', { max: 2 }) ?? null,
      businessName: body.string('business_name') ?? null,
      businessType: body.string('business_type') ?? null,
      defaultCurrency: body.string('default_currency') ?? null,
    };
    const requested = requestedCapabilities(body);
    const metadata = body.metadata();
    body.done();

    const live = req.sandbox.config.fidelity === 'live';
    const missing = missingRequirements(fields);
    const capabilities: Record<string, CapabilityStatus> = {};
    if (live) {
      // Live grants only what was named and blocks activation until required fields are supplied.
      for (const name of requested) capabilities[name] = missing.length ? 'pending' : 'active';
    } else {
      // The official sandbox activates immediately and can grant more than was named.
      for (const name of [...requested, ...AUTO_GRANTED_CAPABILITIES]) capabilities[name] = 'active';
    }
    const account = req.sandbox.accounts.create({
      ...fields,
      capabilities,
      requirementsDue: live ? missing : [],
      metadata: metadata ?? {},
    });
    return created(serializeAccount(account));
  }),

  route('GET', '/v1/accounts', 'accounts.list', (req) => {
    platformOnly(req);
    return list(req, req.sandbox.accounts.list(), serializeAccount);
  }),

  route('GET', '/v1/accounts/:account_id', 'accounts.retrieve', (req) => ok(serializeAccount(req.sandbox.accounts.get(accountId(req))))),

  route('POST', '/v1/accounts/:account_id', 'accounts.update', (req) => {
    const id = accountId(req);
    const body = new BodyReader(req.body);
    const email = body.nullableString('email');
    const country = body.nullableString('country');
    const businessName = body.nullableString('business_name');
    const businessType = body.nullableString('business_type');
    const defaultCurrency = body.nullableString('default_currency');
    const metadata = body.metadata();
    body.done();
    let account = req.sandbox.accounts.update(id, {
      ...(email !== undefined ? { email } : {}),
      ...(country !== undefined ? { country } : {}),
      ...(businessName !== undefined ? { businessName } : {}),
      ...(businessType !== undefined ? { businessType } : {}),
      ...(defaultCurrency !== undefined ? { defaultCurrency } : {}),
      ...(metadata ? { metadata } : {}),
    });
    const missing = missingRequirements(account);
    if (account.requirementsDue.length && !missing.length) {
      account = req.sandbox.accounts.update(id, { requirementsDue: [] });
      for (const [name, status] of Object.entries(account.capabilities)) {
        if (status === 'pending') account = req.sandbox.accounts.setCapability(id, name, 'active');
      }
    }
    return ok(serializeAccount(account));
  }),

  route('POST', '/v1/accounts/:account_id/account-links', 'accounts.links.create', (req) => {
    const link = req.sandbox.accounts.createLink(accountId(req), 'onboarding', 5 * MINUTE);
    return created({ url: link.url, expires_at: link.expiresAt, created_at: link.createdAt });
  }),

  route('POST', '/v1/accounts/:account_id/login_links', 'accounts.login_links.create', (req) => {
    const link = req.sandbox.accounts.createLink(accountId(req), 'login', 5 * MINUTE);
    return created({ url: link.url, created_at: link.createdAt });
  }),

  route('POST', '/v1/accounts/:account_id/dashboard_invite', 'accounts.dashboard_invite', (req) => {
    const id = accountId(req);
    const body = new BodyReader(req.body);
    const email = body.string('email') ?? req.sandbox.accounts.get(id).email;
    body.done();
    if (!email) throw new SandboxError('validation_failed', 'An email is required.', { fieldErrors: [{ field: 'email', message: 'Required.' }] });
    const link = req.sandbox.accounts.createLink(id, 'dashboard_invite', 7 * 24 * 60 * MINUTE);
    return created({ account: id, email, url: link.url, expires_at: link.expiresAt, created_at: link.createdAt });
  }),

  route('POST', '/v1/accounts/:account_id/documents', 'accounts.documents.create', (req) => {
    const id = accountId(req);
    const body = new BodyReader(req.body);
    const purpose = body.string('purpose', { required: true });
    const fileName = body.string('file_name');
    const personId = body.string('person_id');
    body.done();
    return created(serializeDocument(req.sandbox.accounts.addDocument(id, { purpose, fileName: fileName ?? null, personId: personId ?? null })));
  }),

  route('GET', '/v1/accounts/:account_id/documents', 'accounts.documents.list', (req) =>
    list(req, req.sandbox.accounts.listDocuments(accountId(req)), serializeDocument),
  ),

  route('GET', '/v1/accounts/:account_id/capabilities', 'accounts.capabilities.list', (req) => {
    const account = req.sandbox.accounts.get(accountId(req));
    return ok({ items: Object.entries(account.capabilities).map(([id, status]) => ({ id, account: account.id, status })) });
  }),

  route('GET', '/v1/accounts/:account_id/capabilities/:capability', 'accounts.capabilities.retrieve', (req) => {
    const account = req.sandbox.accounts.get(accountId(req));
    const name = req.params.capability ?? '';
    const status = account.capabilities[name];
    if (!status) throw new SandboxError('not_found', `Capability '${name}' has not been requested for ${account.id}.`);
    return ok({ id: name, account: account.id, status });
  }),

  route('POST', '/v1/accounts/:account_id/capabilities/:capability', 'accounts.capabilities.update', (req) => {
    const id = accountId(req);
    const body = new BodyReader(req.body);
    const requested = body.boolean('requested') ?? true;
    body.done();
    const name = req.params.capability ?? '';
    const current = req.sandbox.accounts.get(id);
    const status: CapabilityStatus = !requested ? 'inactive' : current.requirementsDue.length ? 'pending' : 'active';
    const account = req.sandbox.accounts.setCapability(id, name, status);
    return ok({ id: name, account: account.id, status: account.capabilities[name] });
  }),

  // Persons

  route('GET', '/v1/accounts/:account_id/persons', 'persons.list', (req) => list(req, req.sandbox.accounts.listPersons(accountId(req)), serializePerson)),

  route('POST', '/v1/accounts/:account_id/persons', 'persons.create', (req) => {
    const id = accountId(req);
    const body = new BodyReader(req.body);
    const input = readPerson(body);
    body.done();
    return created(serializePerson(req.sandbox.accounts.addPerson(id, input)));
  }),

  route('GET', '/v1/accounts/:account_id/persons/:person_id', 'persons.retrieve', (req) =>
    ok(serializePerson(req.sandbox.accounts.getPerson(accountId(req), req.params.person_id ?? ''))),
  ),

  route('POST', '/v1/accounts/:account_id/persons/:person_id', 'persons.update', (req) => {
    const id = accountId(req);
    const body = new BodyReader(req.body);
    const input = readPerson(body);
    body.done();
    return ok(serializePerson(req.sandbox.accounts.updatePerson(id, req.params.person_id ?? '', input)));
  }),

  route('DELETE', '/v1/accounts/:account_id/persons/:person_id', 'persons.remove', (req) =>
    ok({ ...serializePerson(req.sandbox.accounts.removePerson(accountId(req), req.params.person_id ?? '')), deleted: true }),
  ),

  route('POST', '/v1/accounts/:account_id/persons/:person_id/documents', 'persons.documents.create', (req) => {
    const id = accountId(req);
    const body = new BodyReader(req.body);
    const purpose = body.string('purpose', { required: true });
    const fileName = body.string('file_name');
    body.done();
    return created(serializeDocument(req.sandbox.accounts.addDocument(id, { purpose, fileName: fileName ?? null, personId: req.params.person_id ?? null })));
  }),

  // Transfers and platform fees

  route('POST', '/v1/transfers', 'transfers.create', (req) => {
    platformOnly(req);
    const body = new BodyReader(req.body);
    const destination = body.string('destination', { required: true });
    const currency = body.currency('currency', { required: true });
    const amount = body.amount('amount', currency, { required: true });
    const description = body.string('description');
    const metadata = body.metadata();
    body.done();
    const transfer = req.sandbox.transfers.create({ destination, amount: amount!, description: description ?? null, metadata: metadata ?? {} });
    return created(serializeTransfer(transfer));
  }),

  route('GET', '/v1/transfers', 'transfers.list', (req) => {
    platformOnly(req);
    return list(req, req.sandbox.transfers.list(req.query.destination ? { destination: req.query.destination } : {}), serializeTransfer);
  }),

  route('GET', '/v1/transfers/:transfer_id', 'transfers.retrieve', (req) => {
    platformOnly(req);
    return ok(serializeTransfer(req.sandbox.transfers.get(req.params.transfer_id ?? '')));
  }),

  route('GET', '/v1/platform_fees', 'platform_fees.list', (req) => {
    platformOnly(req);
    return list(req, req.sandbox.transfers.listPlatformFees(req.query.account ? { accountId: req.query.account } : {}), serializePlatformFee);
  }),

  route('GET', '/v1/platform_fees/:fee_id', 'platform_fees.retrieve', (req) => {
    platformOnly(req);
    return ok(serializePlatformFee(req.sandbox.transfers.getPlatformFee(req.params.fee_id ?? '')));
  }),
];
