import { SandboxError, type ProviderWebhookEventRecord, type WebhookDelivery } from '@mockrail/core';
import { BACHS } from '../constants.js';
import { BodyReader } from '../request.js';
import { serializeWebhookEndpoint } from '../serializers.js';
import { created, list, ok, route, type RouteFactory } from './helpers.js';

const P = BACHS.providerId;

function serializeEvent(e: ProviderWebhookEventRecord) {
  return e.body;
}

function serializeDelivery(d: WebhookDelivery) {
  return { id: d.id, event_id: d.eventId, endpoint_id: d.endpointId, status: d.status, scheduled_for: d.scheduledFor };
}

/** Webhook admin. Paths follow the docs index; request and response shapes are unverified (see UNVERIFIED.md). */
export const webhookRoutes: RouteFactory = () => [
  route('POST', '/v1/webhooks/endpoints', 'webhooks.endpoints.create', (req) => {
    const body = new BodyReader(req.body);
    const url = body.string('url', { required: true });
    const description = body.string('description');
    const enabledEvents = body.stringArray('enabled_events');
    const metadata = body.metadata();
    body.done();
    const endpoint = req.sandbox.webhooks.createEndpoint({
      providerId: P,
      ownerId: req.ownerId,
      url,
      description: description ?? null,
      enabledEvents: enabledEvents ?? ['*'],
      metadata: metadata ?? {},
    });
    return created(serializeWebhookEndpoint(endpoint, { includeSecret: true }));
  }),

  route('GET', '/v1/webhooks/endpoints', 'webhooks.endpoints.list', (req) =>
    list(req, req.sandbox.webhooks.listEndpoints(P), (e) => serializeWebhookEndpoint(e)),
  ),

  route('GET', '/v1/webhooks/endpoints/:endpoint_id', 'webhooks.endpoints.retrieve', (req) =>
    ok(serializeWebhookEndpoint(req.sandbox.webhooks.getEndpoint(P, req.params.endpoint_id ?? ''))),
  ),

  route('PATCH', '/v1/webhooks/endpoints/:endpoint_id', 'webhooks.endpoints.update', (req) => {
    const body = new BodyReader(req.body);
    const url = body.string('url');
    const description = body.nullableString('description');
    const enabledEvents = body.stringArray('enabled_events');
    const enabled = body.boolean('enabled');
    const metadata = body.metadata();
    body.done();
    const endpoint = req.sandbox.webhooks.updateEndpoint(P, req.params.endpoint_id ?? '', {
      ...(url ? { url } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(enabledEvents ? { enabledEvents } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(metadata ? { metadata } : {}),
    });
    return ok(serializeWebhookEndpoint(endpoint));
  }),

  route('DELETE', '/v1/webhooks/endpoints/:endpoint_id', 'webhooks.endpoints.delete', (req) =>
    ok({ ...serializeWebhookEndpoint(req.sandbox.webhooks.deleteEndpoint(P, req.params.endpoint_id ?? '')), deleted: true }),
  ),

  // The old secret stays valid for 24 hours after rotation.
  route('POST', '/v1/webhooks/endpoints/:endpoint_id/rotate-secret', 'webhooks.endpoints.rotate_secret', (req) => {
    const endpoint = req.sandbox.webhooks.rotateSecret(P, req.params.endpoint_id ?? '', { overlapMs: BACHS.webhookSecretOverlapMs });
    return ok(serializeWebhookEndpoint(endpoint, { includeSecret: true }));
  }),

  route('GET', '/v1/webhooks/events', 'webhooks.events.list', (req) =>
    list(req, req.sandbox.webhooks.listEvents({ providerId: P, ...(req.query.type ? { type: req.query.type } : {}) }), serializeEvent),
  ),

  route('GET', '/v1/webhooks/events/:event_id', 'webhooks.events.retrieve', (req) =>
    ok(serializeEvent(req.sandbox.webhooks.getEvent(P, req.params.event_id ?? ''))),
  ),

  // Resends are a single attempt.
  route('POST', '/v1/webhooks/events/:event_id/resend', 'webhooks.events.resend', (req) => {
    const event = req.sandbox.webhooks.getEvent(P, req.params.event_id ?? '');
    const body = new BodyReader(req.body);
    const endpointId = body.string('endpoint_id');
    body.done();
    const deliveries = req.sandbox.webhooks.requestRedelivery({ eventId: event.id, kind: 'resend', ...(endpointId ? { endpointId } : {}) });
    return ok({ event_id: event.id, deliveries: deliveries.map(serializeDelivery) });
  }),

  // Replays are single attempts of every matching event.
  route('POST', '/v1/webhooks/replay', 'webhooks.replay', (req) => {
    const body = new BodyReader(req.body);
    const eventIds = body.stringArray('event_ids');
    const type = body.string('type');
    const since = body.string('since');
    const until = body.string('until');
    const endpointId = body.string('endpoint_id');
    body.done();
    if (!eventIds?.length && !since && !type) throw new SandboxError('bad_request', 'Provide event_ids, or a since/type filter.');
    const events = eventIds?.length
      ? eventIds.map((id) => req.sandbox.webhooks.getEvent(P, id))
      : req.sandbox.webhooks.listEvents({ providerId: P, ...(type ? { type } : {}), ...(since ? { since } : {}), ...(until ? { until } : {}) }).reverse();
    const deliveries = events.flatMap((e) => req.sandbox.webhooks.requestRedelivery({ eventId: e.id, kind: 'replay', ...(endpointId ? { endpointId } : {}) }));
    return ok({ replayed: events.length, deliveries: deliveries.map(serializeDelivery) });
  }),
];
