import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export interface PreviousSecret {
  readonly secret: string;
  readonly expiresAt: string;
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly providerId: string;
  readonly ownerId: string;
  readonly url: string;
  readonly description: string | null;
  /** Event types to send, or ['*'] for all. */
  readonly enabledEvents: readonly string[];
  readonly status: 'enabled' | 'disabled';
  readonly disabledReason: string | null;
  readonly secret: string;
  readonly previousSecrets: readonly PreviousSecret[];
  readonly failingSince: string | null;
  readonly warningSentAt: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A provider-formatted webhook event, stored so it can be listed, resent and replayed. */
export interface ProviderWebhookEventRecord {
  readonly id: string;
  readonly providerId: string;
  readonly type: string;
  readonly ownerId: string;
  readonly domainEventId: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type DeliveryKind = 'automatic' | 'resend' | 'replay' | 'duplicate';

export interface WebhookDelivery {
  readonly id: string;
  readonly providerId: string;
  readonly eventId: string;
  readonly endpointId: string;
  readonly attempt: number;
  readonly kind: DeliveryKind;
  readonly status: 'scheduled' | 'succeeded' | 'failed' | 'dropped';
  readonly responseStatus: number | null;
  readonly error: string | null;
  readonly durationMs: number | null;
  readonly scheduledFor: string;
  readonly attemptedAt: string | null;
  readonly createdAt: string;
}

export interface AutoDisablePolicy {
  readonly warnAfterMs: number;
  readonly disableAfterMs: number;
  readonly minAfterWarningMs: number;
}

export interface CreateEndpointInput {
  readonly providerId: string;
  readonly ownerId: string;
  readonly url: string;
  readonly description?: string | null;
  readonly enabledEvents?: readonly string[];
  readonly secretPrefix?: string;
  readonly metadata?: Metadata;
}

export interface RedeliveryRequest {
  readonly eventId: string;
  /** Limit to one endpoint; otherwise every endpoint that wants the event type. */
  readonly endpointId?: string;
  readonly kind: 'resend' | 'replay';
}

/** Installed by the server's webhook dispatcher; returns the deliveries it scheduled. */
export type RedeliveryHandler = (request: RedeliveryRequest) => readonly WebhookDelivery[];

export class WebhooksService {
  private redeliveryHandler: RedeliveryHandler | null = null;

  constructor(private readonly ctx: CoreContext) {}

  setRedeliveryHandler(handler: RedeliveryHandler | null): void {
    this.redeliveryHandler = handler;
  }

  /** Resends or replays a stored event as a single attempt. */
  requestRedelivery(request: RedeliveryRequest): readonly WebhookDelivery[] {
    if (!this.redeliveryHandler) throw new Error('No webhook dispatcher is running');
    return this.redeliveryHandler(request);
  }

  // Endpoints

  createEndpoint(input: CreateEndpointInput): WebhookEndpoint {
    assertUrl(input.url);
    const now = this.ctx.nowIso();
    const endpoint: WebhookEndpoint = {
      id: this.ctx.ids.next('we'),
      providerId: input.providerId,
      ownerId: input.ownerId,
      url: input.url,
      description: input.description ?? null,
      enabledEvents: input.enabledEvents?.length ? input.enabledEvents : ['*'],
      status: 'enabled',
      disabledReason: null,
      secret: this.ctx.ids.secret(input.secretPrefix ?? 'whsec_'),
      previousSecrets: [],
      failingSince: null,
      warningSentAt: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.webhookEndpoints, endpoint);
    return endpoint;
  }

  getEndpoint(providerId: string, id: string): WebhookEndpoint {
    const endpoint = this.ctx.store.get<WebhookEndpoint>(C.webhookEndpoints, id);
    if (!endpoint || endpoint.providerId !== providerId) throw notFound('webhook endpoint', id);
    return endpoint;
  }

  findEndpoint(id: string): WebhookEndpoint | null {
    return this.ctx.store.get<WebhookEndpoint>(C.webhookEndpoints, id) ?? null;
  }

  listEndpoints(providerId: string): WebhookEndpoint[] {
    return this.ctx.store.list<WebhookEndpoint>(C.webhookEndpoints, (e) => e.providerId === providerId).sort(byNewest);
  }

  updateEndpoint(
    providerId: string,
    id: string,
    patch: { readonly url?: string; readonly description?: string | null; readonly enabledEvents?: readonly string[]; readonly enabled?: boolean; readonly metadata?: Metadata },
  ): WebhookEndpoint {
    const current = this.getEndpoint(providerId, id);
    if (patch.url) assertUrl(patch.url);
    const reenable = patch.enabled === true && current.status === 'disabled';
    return this.save({
      ...current,
      ...(patch.url ? { url: patch.url } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.enabledEvents ? { enabledEvents: patch.enabledEvents.length ? patch.enabledEvents : ['*'] } : {}),
      ...(patch.enabled === false ? { status: 'disabled' as const, disabledReason: 'manual' } : {}),
      ...(reenable ? { status: 'enabled' as const, disabledReason: null, failingSince: null, warningSentAt: null } : {}),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
    });
  }

  deleteEndpoint(providerId: string, id: string): WebhookEndpoint {
    const endpoint = this.getEndpoint(providerId, id);
    this.ctx.store.delete(C.webhookEndpoints, id);
    return endpoint;
  }

  /** Issues a new secret; the old one stays valid for `overlapMs`. */
  rotateSecret(providerId: string, id: string, options: { readonly overlapMs: number; readonly secretPrefix?: string }): WebhookEndpoint {
    const current = this.getEndpoint(providerId, id);
    const expiresAt = new Date(this.ctx.now().getTime() + options.overlapMs).toISOString();
    return this.save({
      ...current,
      secret: this.ctx.ids.secret(options.secretPrefix ?? 'whsec_'),
      previousSecrets: [...this.liveSecrets(current), { secret: current.secret, expiresAt }],
    });
  }

  /** Current secret first, then previous secrets still inside their overlap window. */
  activeSecrets(endpoint: WebhookEndpoint): string[] {
    return [endpoint.secret, ...this.liveSecrets(endpoint).map((s) => s.secret)];
  }

  wantsEvent(endpoint: WebhookEndpoint, type: string): boolean {
    return endpoint.status === 'enabled' && (endpoint.enabledEvents.includes('*') || endpoint.enabledEvents.includes(type));
  }

  recordSuccess(endpointId: string): void {
    const endpoint = this.findEndpoint(endpointId);
    if (endpoint && (endpoint.failingSince || endpoint.warningSentAt)) {
      this.save({ ...endpoint, failingSince: null, warningSentAt: null });
    }
  }

  /** Tracks consecutive failures; returns what changed so the dispatcher can log it. */
  recordFailure(endpointId: string, policy: AutoDisablePolicy): { readonly warned: boolean; readonly disabled: boolean } {
    const endpoint = this.findEndpoint(endpointId);
    if (!endpoint || endpoint.status === 'disabled') return { warned: false, disabled: false };
    const now = this.ctx.now();
    const failingSince = endpoint.failingSince ?? now.toISOString();
    const failingFor = now.getTime() - Date.parse(failingSince);
    let next: WebhookEndpoint = { ...endpoint, failingSince };
    let warned = false;
    let disabled = false;
    if (!endpoint.warningSentAt && failingFor >= policy.warnAfterMs) {
      next = { ...next, warningSentAt: now.toISOString() };
      warned = true;
    }
    const warningAt = next.warningSentAt ? Date.parse(next.warningSentAt) : null;
    if (failingFor >= policy.disableAfterMs && warningAt !== null && now.getTime() - warningAt >= policy.minAfterWarningMs) {
      next = { ...next, status: 'disabled', disabledReason: 'consecutive_failures' };
      disabled = true;
    }
    this.save(next);
    return { warned, disabled };
  }

  // Provider events

  recordEvent(event: Omit<ProviderWebhookEventRecord, 'createdAt'> & { readonly createdAt?: string }): ProviderWebhookEventRecord {
    const record: ProviderWebhookEventRecord = { ...event, createdAt: event.createdAt ?? this.ctx.nowIso() };
    this.ctx.store.put(C.webhookEvents, record);
    return record;
  }

  getEvent(providerId: string, id: string): ProviderWebhookEventRecord {
    const event = this.ctx.store.get<ProviderWebhookEventRecord>(C.webhookEvents, id);
    if (!event || event.providerId !== providerId) throw notFound('event', id);
    return event;
  }

  findEvent(id: string): ProviderWebhookEventRecord | null {
    return this.ctx.store.get<ProviderWebhookEventRecord>(C.webhookEvents, id) ?? null;
  }

  listEvents(filter: { readonly providerId?: string; readonly type?: string; readonly since?: string; readonly until?: string } = {}): ProviderWebhookEventRecord[] {
    return this.ctx.store
      .list<ProviderWebhookEventRecord>(C.webhookEvents, (e) => {
        if (filter.providerId && e.providerId !== filter.providerId) return false;
        if (filter.type && e.type !== filter.type) return false;
        if (filter.since && e.createdAt < filter.since) return false;
        if (filter.until && e.createdAt > filter.until) return false;
        return true;
      })
      .sort(byNewest);
  }

  // Deliveries

  saveDelivery(delivery: WebhookDelivery): WebhookDelivery {
    this.ctx.store.put(C.webhookDeliveries, delivery);
    return delivery;
  }

  findDelivery(id: string): WebhookDelivery | null {
    return this.ctx.store.get<WebhookDelivery>(C.webhookDeliveries, id) ?? null;
  }

  listDeliveries(filter:{ readonly eventId?: string; readonly endpointId?: string } = {}): WebhookDelivery[] {
    return this.ctx.store
      .list<WebhookDelivery>(C.webhookDeliveries, (d) => (!filter.eventId || d.eventId === filter.eventId) && (!filter.endpointId || d.endpointId === filter.endpointId))
      .sort(byNewest);
  }

  private liveSecrets(endpoint: WebhookEndpoint): PreviousSecret[] {
    const now = this.ctx.now().getTime();
    return endpoint.previousSecrets.filter((s) => Date.parse(s.expiresAt) > now);
  }

  private save(endpoint: WebhookEndpoint): WebhookEndpoint {
    const next = { ...endpoint, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.webhookEndpoints, next);
    return next;
  }
}

function assertUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol');
  } catch {
    throw validationFailed([{ field: 'url', message: 'Must be an absolute http(s) URL.' }]);
  }
}
