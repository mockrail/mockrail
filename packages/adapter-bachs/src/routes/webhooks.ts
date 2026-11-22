import { isPlatformOwner, platformOf, providerOf, type AdapterRequest, type EndpointScope, type ProviderWebhookEventRecord, type WebhookEndpoint } from '@mockrail/core';
import { BACHS, WEBHOOK_EVENT_TYPES, WEBHOOK_SECRET_FORMAT } from '../constants.js';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { serializeEndpointEvent, serializeEventDetail, serializeEventListItem, serializeWebhookEndpoint } from '../view.js';
import { created, list, listWithOffset, ok, route, viewOf, type RouteFactory } from './helpers.js';

const SOURCE_TO_SCOPE: Readonly<Record<string, EndpointScope>> = { account: 'own', connect: 'connected', all: 'all' };

function readEventTypes(body: BodyReader, required: boolean): string[] | undefined {
  const types = body.stringArray('event_types');
  if (types === undefined) {
    if (required) body.fail('event_types', 'This field is required.');
    return undefined;
  }
  if (!types.length) throw bachsError('VALIDATION_ERROR', 400, 'event_types needs at least one event type.', { field: 'event_types' });
  const lower = types.map((t) => t.toLowerCase());
  const unknown = lower.filter((t) => !(WEBHOOK_EVENT_TYPES as readonly string[]).includes(t));
  if (unknown.length) throw bachsError('VALIDATION_ERROR', 400, `Unknown event types: ${unknown.join(', ')}.`, { field: 'event_types' });
  return [...new Set(lower)];
}

/** Receivers must be HTTPS; the sandbox also accepts http on localhost for local development. */
function checkUrl(url: string | undefined): void {
  if (!url) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw bachsError('VALIDATION_ERROR', 400, 'url must be an absolute URL.', { field: 'url' });
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw bachsError('VALIDATION_ERROR', 400, 'url must use HTTPS.', { field: 'url' });
}

function getEndpoint(req: AdapterRequest): WebhookEndpoint {
  return req.sandbox.webhooks.getEndpoint(req.ownerId, req.params.endpoint_id ?? '');
}

/** Events visible to the caller: the platform sees its own and its connected accounts' events. */
function visibleEvents(req: AdapterRequest): ProviderWebhookEventRecord[] {
  return isPlatformOwner(req.ownerId)
    ? req.sandbox.webhooks.listEvents({ providerId: providerOf(req.ownerId), platformOwnerId: platformOf(req.ownerId) })
    : req.sandbox.webhooks.listEvents({ providerId: providerOf(req.ownerId), ownerId: req.ownerId });
}

function getEvent(req: AdapterRequest, id: string): ProviderWebhookEventRecord {
  const event = req.sandbox.webhooks.findEvent(id);
  const visible = event && event.providerId === providerOf(req.ownerId) && (event.ownerId === req.ownerId || (isPlatformOwner(req.ownerId) && platformOf(event.ownerId) === req.ownerId));
  if (!event || !visible) throw bachsError('NOT_FOUND', 404, `No event found with id '${id}'.`);
  return event;
}

export const webhookRoutes: RouteFactory = (options) => [
  route('POST', '/v1/webhooks/endpoints', 'webhooks.endpoints.create', (req) => {
    const body = new BodyReader(req.body);
    const name = body.string('name', { required: true });
    const url = body.string('url', { required: true });
    const eventTypes = readEventTypes(body, true);
    const source = body.oneOf('event_source', ['account', 'connect', 'all'] as const) ?? 'account';
    body.done();
    checkUrl(url);
    const endpoint = req.sandbox.webhooks.createEndpoint({
      providerId: providerOf(req.ownerId),
      ownerId: req.ownerId,
      name,
      url,
      enabledEvents: eventTypes ?? [],
      scope: SOURCE_TO_SCOPE[source] as EndpointScope,
      secretFormat: WEBHOOK_SECRET_FORMAT,
    });
    return created(serializeWebhookEndpoint(endpoint, { includeSecret: true }));
  }),

  route('GET', '/v1/webhooks/endpoints', 'webhooks.endpoints.list', (req) => list(req, req.sandbox.webhooks.listEndpoints({ ownerId: req.ownerId }), (e) => serializeWebhookEndpoint(e), 50)),

  route('GET', '/v1/webhooks/endpoints/:endpoint_id', 'webhooks.endpoints.retrieve', (req) => ok(serializeWebhookEndpoint(getEndpoint(req)))),

  route('GET', '/v1/webhooks/endpoints/:endpoint_id/secret', 'webhooks.endpoints.secret', (req) => {
    const endpoint = getEndpoint(req);
    return ok({ endpoint_id: endpoint.id, signing_secret: endpoint.secret });
  }),

  route('PATCH', '/v1/webhooks/endpoints/:endpoint_id', 'webhooks.endpoints.update', (req) => {
    const body = new BodyReader(req.body);
    const name = body.nullableString('name');
    const url = body.nullableString('url');
    const eventTypes = readEventTypes(body, false);
    const source = body.oneOf('event_source', ['account', 'connect', 'all'] as const);
    const enabled = body.boolean('enabled');
    body.done();
    checkUrl(url ?? undefined);
    const endpoint = req.sandbox.webhooks.updateEndpoint(req.ownerId, req.params.endpoint_id ?? '', {
      ...(name !== undefined ? { name } : {}),
      ...(url ? { url } : {}),
      ...(eventTypes ? { enabledEvents: eventTypes } : {}),
      ...(source ? { scope: SOURCE_TO_SCOPE[source] as EndpointScope } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
    return ok(serializeWebhookEndpoint(endpoint));
  }),

  route('DELETE', '/v1/webhooks/endpoints/:endpoint_id', 'webhooks.endpoints.delete', (req) => {
    const endpoint = req.sandbox.webhooks.deleteEndpoint(req.ownerId, req.params.endpoint_id ?? '');
    return ok({ status: 'deleted', endpoint_id: endpoint.id });
  }),

  /** The old secret keeps signing for 24 hours (Webhooks guide). */
  route('POST', '/v1/webhooks/endpoints/:endpoint_id/rotate-secret', 'webhooks.endpoints.rotate_secret', (req) => {
    const endpoint = req.sandbox.webhooks.rotateSecret(req.ownerId, req.params.endpoint_id ?? '', { overlapMs: BACHS.webhookSecretOverlapMs, secretFormat: WEBHOOK_SECRET_FORMAT });
    return ok(serializeWebhookEndpoint(endpoint, { includeSecret: true }));
  }),

  route('GET', '/v1/webhooks/endpoints/:endpoint_id/metrics', 'webhooks.endpoints.metrics', (req) => {
    const endpoint = getEndpoint(req);
    const period = ['day', 'week', 'month'].includes(req.query.period ?? '') ? (req.query.period as string) : 'day';
    const to = req.query.date_to ? new Date(req.query.date_to) : req.sandbox.clock.now();
    const from = req.query.date_from ? new Date(req.query.date_from) : new Date(to.getTime() - 30 * 86_400_000);
    const bucketKey = (d: Date): string => {
      const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      if (period === 'month') day.setUTCDate(1);
      if (period === 'week') day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
      return day.toISOString().slice(0, 10);
    };
    const buckets = new Map<string, { success: number; failed: number }>();
    for (let d = new Date(from); d <= to; d = new Date(d.getTime() + 86_400_000)) buckets.set(bucketKey(d), { success: 0, failed: 0 });
    for (const delivery of req.sandbox.webhooks.listDeliveries({ endpointId: endpoint.id })) {
      if (!delivery.attemptedAt) continue;
      const at = new Date(delivery.attemptedAt);
      if (at < from || at > to) continue;
      const bucket = buckets.get(bucketKey(at)) ?? { success: 0, failed: 0 };
      if (delivery.status === 'succeeded') bucket.success += 1;
      else bucket.failed += 1;
      buckets.set(bucketKey(at), bucket);
    }
    const data = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
    return ok({ total: String(data.reduce((sum, d) => sum + d.success + d.failed, 0)), period, data });
  }),

  route('GET', '/v1/webhooks/endpoints/:endpoint_id/events', 'webhooks.endpoints.events', (req) => {
    const endpoint = getEndpoint(req);
    const view = viewOf(req, options);
    const ids = new Set(req.sandbox.webhooks.listDeliveries({ endpointId: endpoint.id }).map((d) => d.eventId));
    const events = visibleEvents(req).filter((e) => ids.has(e.id));
    return listWithOffset(req, events, (e) => serializeEndpointEvent(view, e, endpoint.id));
  }),

  route('GET', '/v1/webhooks/endpoints/:endpoint_id/events/:event_id', 'webhooks.endpoints.event', (req) => {
    const endpoint = getEndpoint(req);
    return ok(serializeEventDetail(viewOf(req, options), getEvent(req, req.params.event_id ?? ''), endpoint.id));
  }),

  /** A single attempt; "queued" means accepted, not delivered. */
  route('POST', '/v1/webhooks/endpoints/:endpoint_id/events/:event_id/resend', 'webhooks.endpoints.resend', (req) => {
    const endpoint = getEndpoint(req);
    const event = getEvent(req, req.params.event_id ?? '');
    const [delivery] = req.sandbox.webhooks.requestRedelivery({ eventId: event.id, endpointId: endpoint.id, kind: 'resend' });
    return ok({ status: 'queued', attempt_id: delivery?.id ?? null });
  }),

  route('GET', '/v1/webhooks/events', 'webhooks.events.list', (req) => {
    const view = viewOf(req, options);
    return listWithOffset(req, visibleEvents(req), (e) => serializeEventListItem(view, e));
  }),

  route('GET', '/v1/webhooks/events/:event_id', 'webhooks.events.retrieve', (req) => ok(serializeEventDetail(viewOf(req, options), getEvent(req, req.params.event_id ?? '')))),

  /** Replays one event by event_id, else charge_id, else reference. The event keeps its id. */
  route('POST', '/v1/webhooks/replay', 'webhooks.replay', (req) => {
    const body = new BodyReader(req.body);
    const eventId = body.string('event_id');
    const chargeId = body.string('charge_id');
    const reference = body.string('reference');
    body.done();
    if (!eventId && !chargeId && !reference) throw bachsError('BAD_REQUEST', 400, 'Provide event_id, charge_id or reference.');
    let event: ProviderWebhookEventRecord | undefined;
    if (eventId) event = getEvent(req, eventId);
    else {
      const key = (chargeId ?? reference) as string;
      const matches = visibleEvents(req).filter((e) => e.references.includes(key));
      event = matches.find((e) => e.type.startsWith('collection.')) ?? matches[0];
    }
    if (!event) throw bachsError('NOT_FOUND', 404, 'No event matches that lookup.');
    const [delivery] = req.sandbox.webhooks.requestRedelivery({ eventId: event.id, kind: 'replay' });
    if (!delivery) throw bachsError('NOT_FOUND', 404, 'No enabled endpoint is subscribed to this event.');
    return ok({ event_id: event.id, attempt_id: delivery.id, attempt_no: delivery.attempt, event_type: event.type });
  }),
];
