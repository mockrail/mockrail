import {
  isPlatformOwner,
  localOf,
  MINUTE,
  type AdapterRequest,
  type Capability,
  type ConnectedAccount,
  type PersonInput,
} from '@mockrail/core';
import { CAPABILITIES } from '../constants.js';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import {
  serializeAccount,
  serializeAccountLink,
  serializeCapabilityItem,
  serializeDocument,
  serializePerson,
  serializePlatformFee,
  serializeTransfer,
} from '../view.js';
import { created, list, ok, platformOwnerOf, route, viewOf, type RouteFactory } from './helpers.js';

type Persona = keyof typeof CAPABILITIES;
const PERSONAS = Object.keys(CAPABILITIES) as Persona[];
const DASHBOARD_LEVEL = { none: 0, light: 1, full: 2 } as const;

/** Connect management is a platform operation. */
function platformOnly(req: AdapterRequest): string {
  if (!isPlatformOwner(req.ownerId)) throw bachsError('FORBIDDEN', 403, 'This endpoint is only available to the platform, not while acting as an account.');
  return req.ownerId;
}

function getAccount(req: AdapterRequest): ConnectedAccount {
  const platform = platformOnly(req);
  return req.sandbox.accounts.get(platform, req.params.account_id ?? '');
}

/** Requirements owed (sandbox owes the same fields as live). */
function initialRequirements(entityType: string | null): string[] {
  return entityType === 'company' ? ['company.registration_number', 'company.address'] : ['individual.dob', 'individual.address'];
}

/** Flattens `fields` ({ company: { registration_number } } or { "company.registration_number": ... }). */
function flatten(value: unknown, prefix = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? { [prefix]: value } : {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null && !Array.isArray(v) && !key.endsWith('address') ? { ...acc, ...flatten(v, key) } : { ...acc, [key]: v };
  }, {});
}

interface CapabilityRequest {
  readonly name: string;
  readonly requested: boolean;
  readonly international?: boolean;
}

/** Parses `configuration: { merchant|recipient: { capabilities: { name: { requested, international } } } }`. */
function readConfiguration(raw: unknown, onCreate: boolean): CapabilityRequest[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bachsError('VALIDATION_ERROR', 400, 'configuration must be an object.', { field: 'configuration' });
  const personas = Object.entries(raw as Record<string, unknown>);
  if (!personas.length) throw bachsError('VALIDATION_ERROR', 422, 'configuration needs at least one of merchant or recipient.', { field: 'configuration' });
  const out: CapabilityRequest[] = [];
  for (const [persona, value] of personas) {
    if (!PERSONAS.includes(persona as Persona)) throw bachsError('invalid_configuration', 400, `Unknown configuration '${persona}'. Use merchant or recipient.`, { field: 'configuration' });
    const allowed = CAPABILITIES[persona as Persona] as readonly string[];
    const caps = (value as { capabilities?: Record<string, { requested?: boolean; international?: boolean | null }> } | null)?.capabilities;
    if (!caps) {
      // Omitting capabilities on create requests every capability the configuration allows.
      if (onCreate) for (const name of allowed) out.push({ name, requested: true });
      continue;
    }
    for (const [name, opts] of Object.entries(caps)) {
      const known = PERSONAS.some((p) => (CAPABILITIES[p] as readonly string[]).includes(name));
      if (!known) throw bachsError('unknown_capability', 400, `Unknown capability '${name}'.`, { field: `configuration.${persona}.capabilities.${name}` });
      if (!allowed.includes(name)) throw bachsError('capability_configuration_mismatch', 400, `'${name}' belongs to a different configuration.`, { field: `configuration.${persona}.capabilities.${name}` });
      if (opts?.international != null && name !== 'payouts') throw bachsError('capability_option_not_supported', 400, `'international' only applies to payouts.`);
      if (opts?.international === true && opts.requested === false) throw bachsError('VALIDATION_ERROR', 422, 'international: true cannot be combined with requested: false.');
      out.push({ name, requested: opts?.requested ?? opts?.international === true, ...(opts?.international != null ? { international: opts.international } : {}) });
    }
  }
  return out;
}

function readPerson(body: BodyReader): PersonInput {
  const firstName = body.nullableString('first_name');
  const lastName = body.nullableString('last_name');
  const email = body.nullableString('email');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bachsError('VALIDATION_ERROR', 422, 'Enter a valid email address.', { field: 'email' });
  const phone = body.nullableString('phone');
  if (phone && phone.length > 32) body.fail('phone', 'Must be at most 32 characters.');
  const attributes: Record<string, unknown> = {};
  for (const key of ['dob', 'address', 'relationship', 'id_numbers'] as const) {
    const v = body.raw(key);
    if (v !== undefined) attributes[key] = v;
  }
  if (body.raw('id_number') !== undefined || body.raw('id_numbers') !== undefined) attributes.id_number_provided = true;
  return {
    ...(firstName !== undefined ? { firstName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
    ...(email !== undefined ? { email } : {}),
    ...(phone !== undefined ? { phone } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}

export const connectRoutes: RouteFactory = (options) => [
  route('POST', '/v1/accounts', 'accounts.create', (req) => {
    const platform = platformOnly(req);
    const body = new BodyReader(req.body);
    const email = body.string('contact_email', { required: true });
    const displayName = body.nullableString('display_name');
    const firstName = body.nullableString('first_name');
    const lastName = body.nullableString('last_name');
    const country = body.nullableString('country');
    const entityType = body.oneOf('entity_type', ['company', 'individual'] as const);
    const responsibilities = body.object('responsibilities');
    const fees = responsibilities?.object('fees');
    const feeCollector = fees?.oneOf('collector', ['platform', 'bachs'] as const) ?? 'bachs';
    const dashboard = body.oneOf('dashboard', ['none', 'light', 'full'] as const) ?? 'none';
    const dashboardFeatures = body.raw('dashboard_features');
    const configurationRaw = body.raw('configuration');
    body.done();
    const requests = readConfiguration(configurationRaw, true) ?? [];

    const live = req.sandbox.config.fidelity === 'live';
    const capabilities: Record<string, Capability> = {};
    if (live) {
      // Live grants only what was named; a requested capability lands as restricted until checks pass.
      for (const r of requests) capabilities[r.name] = { status: r.requested ? 'restricted' : 'unrequested', requested: r.requested, ...(r.international !== undefined ? { international: r.international } : {}) };
    } else {
      // The sandbox grants the configuration's whole allowed set as active; recipients also get conversions.
      const personas = Object.keys((configurationRaw as Record<string, unknown> | undefined) ?? {}) as Persona[];
      for (const persona of personas) for (const name of CAPABILITIES[persona]) capabilities[name] = { status: 'active', requested: true };
      for (const r of requests) capabilities[r.name] = { status: 'active', requested: true, ...(r.name === 'payouts' ? { international: r.international ?? true } : {}) };
      if (personas.includes('recipient')) capabilities.conversions = { status: 'active', requested: true };
    }

    const account = req.sandbox.accounts.create({
      platformOwnerId: platform,
      email,
      country: country?.toUpperCase() ?? null,
      displayName: displayName ?? ([firstName, lastName].filter(Boolean).join(' ') || null),
      capabilities,
      requirementsDue: initialRequirements(entityType ?? null),
      attributes: {
        entity_type: entityType ?? null,
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        fee_collector: feeCollector,
        dashboard,
        dashboard_features: dashboardFeatures ?? undefined,
        dashboard_access: 'not_invited',
        configuration: configurationRaw ?? {},
        balance_currencies: ['USD'],
        fields: {},
      },
    });
    return created(serializeAccount(viewOf(req, options), account, { single: true }));
  }),

  route('GET', '/v1/accounts', 'accounts.list', (req) => {
    const view = viewOf(req, options);
    return list(req, req.sandbox.accounts.list(platformOnly(req)), (a) => serializeAccount(view, a), 50);
  }),

  route('GET', '/v1/accounts/:account_id', 'accounts.retrieve', (req) => ok(serializeAccount(viewOf(req, options), getAccount(req), { single: true }))),

  /** Update is POST, not PATCH. */
  route('POST', '/v1/accounts/:account_id', 'accounts.update', (req) => {
    const current = getAccount(req);
    const platform = current.platformOwnerId;
    const sandbox = req.sandbox;
    const body = new BodyReader(req.body);
    const displayName = body.nullableString('display_name');
    const email = body.nullableString('contact_email');
    const dashboard = body.oneOf('dashboard', ['none', 'light', 'full'] as const);
    const dashboardFeatures = body.raw('dashboard_features');
    const fieldsRaw = body.raw('fields');
    const balanceCurrencies = body.raw('balance_currencies');
    const configurationRaw = body.raw('configuration');
    body.done();
    const attrs = current.attributes as Record<string, unknown>;

    if (dashboard && DASHBOARD_LEVEL[dashboard] < DASHBOARD_LEVEL[(attrs.dashboard as keyof typeof DASHBOARD_LEVEL) ?? 'none']) {
      throw bachsError('dashboard_cannot_be_lowered', 400, 'The dashboard mode cannot be lowered.', { field: 'dashboard' });
    }
    const fields = { ...((attrs.fields as Record<string, unknown>) ?? {}), ...flatten(fieldsRaw) };
    const address = fields['company.address'] ?? fields['individual.address'] ?? attrs.address;
    let currencies = (attrs.balance_currencies as string[] | undefined) ?? ['USD'];
    if (balanceCurrencies && typeof balanceCurrencies === 'object') {
      for (const [code, held] of Object.entries(balanceCurrencies as Record<string, boolean>)) {
        currencies = held ? [...new Set([...currencies, code.toUpperCase()])] : currencies.filter((c) => c !== code.toUpperCase() || c === 'USD');
      }
    }
    const due = current.requirementsDue.filter((r) => fields[r] === undefined || fields[r] === null || fields[r] === '');

    let account = sandbox.accounts.update(platform, current.id, {
      ...(displayName !== undefined ? { displayName } : {}),
      ...(email !== undefined ? { email } : {}),
      requirementsDue: due,
      attributes: {
        fields,
        balance_currencies: currencies,
        ...(address ? { address } : {}),
        ...(dashboard ? { dashboard } : {}),
        ...(dashboardFeatures !== undefined ? { dashboard_features: dashboardFeatures } : {}),
      },
    });

    const live = sandbox.config.fidelity === 'live';
    for (const r of readConfiguration(configurationRaw, false) ?? []) {
      const existing = account.capabilities[r.name];
      if (!r.requested) {
        if (existing?.status === 'active') throw bachsError('capability_active', 400, `'${r.name}' is active and cannot be withdrawn.`);
        account = sandbox.accounts.setCapability(platform, account.id, r.name, { status: 'unrequested', requested: false });
        continue;
      }
      // The sandbox grants only the capabilities named in an update.
      const status = live ? (due.length ? 'restricted' : 'active') : 'active';
      account = sandbox.accounts.setCapability(platform, account.id, r.name, { status, requested: true, ...(r.international !== undefined ? { international: r.international } : existing?.international !== undefined ? { international: existing.international } : {}) });
    }
    // Live: once nothing is owed, restricted capabilities go active.
    if (live && !due.length) {
      for (const [name, c] of Object.entries(account.capabilities)) {
        if (c.status === 'restricted' && c.requested) account = sandbox.accounts.setCapability(platform, account.id, name, { ...c, status: 'active' });
      }
    }
    return ok(serializeAccount(viewOf(req, options), account, { single: true }));
  }),

  route('POST', '/v1/accounts/:account_id/account-links', 'accounts.links.create', (req) => {
    const account = getAccount(req);
    const body = new BodyReader(req.body);
    const type = body.oneOf('type', ['onboarding', 'update', 'liveness'] as const, { required: true });
    body.string('refresh_url', { required: true });
    body.string('return_url', { required: true });
    body.done();
    if (type === 'update' && !account.requirementsDue.length) throw bachsError('CONNECTED_ACCOUNT_REQUIREMENTS_NOT_FOUND', 400, 'This account has no requirements to update.');
    if (type === 'liveness') throw bachsError('CONNECTED_ACCOUNT_LIVENESS_NOT_NEEDED', 400, 'This account does not owe a liveness check.');
    const link = req.sandbox.accounts.createLink(account.platformOwnerId, account.id, type!, 5 * MINUTE);
    return ok(serializeAccountLink(link, account.id));
  }),

  route('POST', '/v1/accounts/:account_id/login_links', 'accounts.login_links.create', (req) => {
    const account = getAccount(req);
    if ((account.attributes as Record<string, unknown>).dashboard !== 'light') throw bachsError('login_links_need_light', 400, 'Login links need the light dashboard.');
    const link = req.sandbox.accounts.createLink(account.platformOwnerId, account.id, 'login', 5 * MINUTE);
    return ok({ url: link.url, expires_at: link.expiresAt });
  }),

  /** The invite email is not sent in the sandbox. */
  route('POST', '/v1/accounts/:account_id/dashboard_invite', 'accounts.dashboard_invite', (req) => {
    const account = getAccount(req);
    const attrs = account.attributes as Record<string, unknown>;
    if (attrs.dashboard !== 'full') throw bachsError('dashboard_invite_needs_full', 400, 'Dashboard invites need the full dashboard.');
    if (!account.email) throw bachsError('dashboard_invite_needs_email', 400, 'The account has no contact email.');
    if (attrs.dashboard_access === 'active') throw bachsError('dashboard_access_already_active', 400, 'Dashboard access is already active.');
    const updated = req.sandbox.accounts.update(account.platformOwnerId, account.id, { attributes: { dashboard_access: 'invited' } });
    return ok({ dashboard: 'full', dashboard_access: (updated.attributes as Record<string, unknown>).dashboard_access });
  }),

  route('POST', '/v1/accounts/:account_id/documents', 'accounts.documents.create', (req) => {
    const account = getAccount(req);
    const body = new BodyReader(req.body);
    const file = body.string('file', { required: true });
    const document = body.string('document', { required: true });
    body.done();
    return created(serializeDocument(req.sandbox.accounts.addDocument(account.platformOwnerId, account.id, { slot: document, fileId: file, fileName: `${file}.pdf` })));
  }),

  route('GET', '/v1/accounts/:account_id/capabilities', 'accounts.capabilities.list', (req) => {
    const account = getAccount(req);
    return ok({ items: Object.entries(account.capabilities).map(([name, c]) => serializeCapabilityItem(name, c)) });
  }),

  // Persons

  route('GET', '/v1/accounts/:account_id/persons', 'persons.list', (req) => {
    const account = getAccount(req);
    return list(req, req.sandbox.accounts.listPersons(account.platformOwnerId, account.id), serializePerson, 50);
  }),

  route('POST', '/v1/accounts/:account_id/persons', 'persons.create', (req) => {
    const account = getAccount(req);
    const body = new BodyReader(req.body);
    const input = readPerson(body);
    body.done();
    return created(serializePerson(req.sandbox.accounts.addPerson(account.platformOwnerId, account.id, input)));
  }),

  route('GET', '/v1/accounts/:account_id/persons/:person_id', 'persons.retrieve', (req) => {
    const account = getAccount(req);
    return ok(serializePerson(req.sandbox.accounts.getPerson(account.platformOwnerId, account.id, req.params.person_id ?? '')));
  }),

  route('POST', '/v1/accounts/:account_id/persons/:person_id', 'persons.update', (req) => {
    const account = getAccount(req);
    const body = new BodyReader(req.body);
    const input = readPerson(body);
    body.done();
    return ok(serializePerson(req.sandbox.accounts.updatePerson(account.platformOwnerId, account.id, req.params.person_id ?? '', input)));
  }),

  route('DELETE', '/v1/accounts/:account_id/persons/:person_id', 'persons.remove', (req) => {
    const account = getAccount(req);
    return ok({ ...serializePerson(req.sandbox.accounts.removePerson(account.platformOwnerId, account.id, req.params.person_id ?? '')), deleted: true });
  }),

  route('POST', '/v1/accounts/:account_id/persons/:person_id/documents', 'persons.documents.create', (req) => {
    const account = getAccount(req);
    const body = new BodyReader(req.body);
    const file = body.string('file', { required: true });
    const document = body.string('document', { required: true });
    body.done();
    return created(serializeDocument(req.sandbox.accounts.addDocument(account.platformOwnerId, account.id, { slot: document, fileId: file, fileName: `${file}.pdf`, personId: req.params.person_id ?? null })));
  }),

  // Transfers and platform fees

  /**
   * Draws on the available balance only. With X-Account-Id the account is debited; destination
   * "self" then returns funds to the platform.
   */
  route('POST', '/v1/transfers', 'transfers.create', (req) => {
    const sandbox = req.sandbox;
    const platform = platformOwnerOf(req);
    const body = new BodyReader(req.body);
    const destination = body.string('destination', { required: true });
    const currency = body.currency('currency', { required: true });
    const amount = body.amount('amount', currency, { required: true });
    const description = body.nullableString('description');
    if (description && description.length > 500) body.fail('description', 'Must be at most 500 characters.');
    const transferGroup = body.nullableString('transfer_group');
    const metadata = body.metadata();
    body.done();

    const acting = !isPlatformOwner(req.ownerId);
    const sourceOwner = req.ownerId;
    let destinationOwner: string;
    if (destination === 'self') {
      if (!acting) throw bachsError('VALIDATION_ERROR', 400, 'destination "self" needs X-Account-Id.', { field: 'destination' });
      destinationOwner = platform;
    } else {
      const account = sandbox.accounts.find(destination);
      if (!account || account.platformOwnerId !== platform) throw bachsError('NOT_FOUND', 404, `No account found with id '${destination}'.`);
      destinationOwner = sandbox.accounts.ownerOf(account);
    }
    // The connected account needs an active transfers capability in either direction.
    const accountSide = sandbox.accounts.find(localOf(acting ? sourceOwner : destinationOwner));
    if (accountSide && accountSide.capabilities.transfers?.status !== 'active') {
      throw bachsError('FORBIDDEN', 403, `The transfers capability is not active on ${accountSide.id}.`);
    }
    const transfer = sandbox.transfers.create({ sourceOwner, destinationOwner, amount: amount!, transferGroup: transferGroup ?? null, description: description ?? null, metadata: metadata ?? {} });
    return created(serializeTransfer(viewOf(req, options), transfer));
  }),

  route('GET', '/v1/transfers', 'transfers.list', (req) => {
    const platform = platformOnly(req);
    const view = viewOf(req, options);
    const accountId = req.query.connected_account_id;
    const account = accountId ? req.sandbox.accounts.find(accountId) : null;
    const kind = req.query.kind === 'payout' || req.query.kind === 'manual' ? req.query.kind : undefined;
    const items = req.sandbox.transfers.list(platform, { ...(account ? { owner: req.sandbox.accounts.ownerOf(account) } : {}), ...(kind ? { kind } : {}) });
    return list(req, items, (t) => serializeTransfer(view, t), 50);
  }),

  route('GET', '/v1/transfers/:transfer_id', 'transfers.retrieve', (req) => ok(serializeTransfer(viewOf(req, options), req.sandbox.transfers.get(platformOwnerOf(req), req.params.transfer_id ?? '')))),

  route('GET', '/v1/platform_fees', 'platform_fees.list', (req) => {
    const view = viewOf(req, options);
    return list(req, req.sandbox.transfers.listPlatformFees(platformOnly(req), req.query.charge ? { chargeId: req.query.charge } : {}), (f) => serializePlatformFee(view, f), 50);
  }),

  route('GET', '/v1/platform_fees/:fee_id', 'platform_fees.retrieve', (req) => ok(serializePlatformFee(viewOf(req, options), req.sandbox.transfers.getPlatformFee(platformOnly(req), req.params.fee_id ?? '')))),
];
