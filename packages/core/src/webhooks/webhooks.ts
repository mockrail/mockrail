import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { isPlatformOwner, platformOf } from '../shared/owners.js';

export interface PreviousSecret {
  readonly secret: string;
  readonly expiresAt: string;
}

/** Which events an endpoint receives: its owner's own, its connected accounts', or both. */
export type EndpointScope = 'own' | 'connected' | 'all';

export interface WebhookEndpoint {
  readonly id: string;
  readonly providerId: string;
  readonly ownerId: string;
  readonly name: string | null;
  readonly url: string;
  /** Event types to send, or ['*'] for all. */
  readonly enabledEvents: readonly string[];
  readonly scope: EndpointScope;
  readonly status: 'enabled' | 'disabled';
  readonly disabledReason: string | null;
  readonly disabledAt: string | null;
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
  /** The resource the event is about (type and id), for lookups such as replay by charge. */
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly references: readonly string[];
  readonly body: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export type DeliveryKind = 'automatic' | 'resend' | 'replay' | 'duplicate';

export interface WebhookDelivery {
  readonly id: string;
  readonly providerId: string;
  readonly eventId: string;
  readonly endpointId: string;
  readonly url: string;
  /** 1-based attempt number for this event and endpoint (resends and replays continue the count). */
  readonly attempt: number;
  readonly kind: DeliveryKind;
  readonly status: 'scheduled' | 'succeeded' | 'failed' | 'dropped';
  readonly responseStatus: number | null;
  readonly responseSnippet: string | null;
  readonly error: string | null;
  readonly durationMs: number | null;
  readonly scheduledFor: string;
  readonly attemptedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AutoDisablePolicy {
  readonly warnAfterMs: number;
  readonly disableAfterMs: number;
  readonly minAfterWarningMs: number;
}

export interface SecretFormat {
  readonly prefix: string;
  readonly alphabet?: 'base62' | 'hex';
  readonly length?: number;
}

export interface CreateEndpointInput {
  readonly providerId: string;
  readonly ownerId: string;
  readonly url: string;
  readonly name?: string | null;
  readonly enabledEvents?: readonly string[];
  readonly scope?: EndpointScope;
  readonly secretFormat?: SecretFormat;
  readonly metadata?: Metadata;
}

export interface RedeliveryRequest {
  readonly eventId: string;
  /** Limit to one endpoint; otherwise every endpoint that wants the event. */
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
    const format = input.secretFormat ?? { prefix: 'whsec_' };
    const endpoint: WebhookEndpoint = {
      id: this.ctx.ids.entity('webhook_endpoint', input.ownerId),
      providerId: input.providerId,
      ownerId: input.ownerId,
      name: input.name ?? null,
      url: input.url,
      enabledEvents: input.enabledEvents?.length ? input.enabledEvents : ['*'],
      scope: input.scope ?? 'own',
      status: 'enabled',
      disabledReason: null,
      disabledAt: null,
      secret: this.ctx.ids.secret(format.prefix, format),
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

  getEndpoint(ownerId: string, id: string): WebhookEndpoint {
    const endpoint = this.ctx.store.get<WebhookEndpoint>(C.webhookEndpoints, id);
    if (!endpoint || endpoint.ownerId !== ownerId) throw notFound('webhook endpoint', id);
    return endpoint;
  }

  findEndpoint(id: string): WebhookEndpoint | null {
    return this.ctx.store.get<WebhookEndpoint>(C.webhookEndpoints, id) ?? null;
  }

  /** Endpoints registered by an owner, or every endpoint of a provider. */
  listEndpoints(filter: { readonly ownerId?: string; readonly providerId?: string }): WebhookEndpoint[] {
    return this.ctx.store
      .list<WebhookEndpoint>(C.webhookEndpoints, (e) => (!filter.ownerId || e.ownerId === filter.ownerId) && (!filter.providerId || e.providerId === filter.providerId))
      .sort(byNewest);
  }

  updateEndpoint(
    ownerId: string,
    id: string,
    patch: { readonly url?: string; readonly name?: string | null; readonly enabledEvents?: readonly string[]; readonly scope?: EndpointScope; readonly enabled?: boolean; readonly metadata?: Metadata },
  ): WebhookEndpoint {
    const current = this.getEndpoint(ownerId, id);
    if (patch.url) assertUrl(patch.url);
    if (patch.enabledEvents && patch.enabledEvents.length === 0) throw validationFailed([{ field: 'event_types', message: 'Provide at least one event type.' }]);
    let next: WebhookEndpoint = {
      ...current,
      ...(patch.url ? { url: patch.url } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.enabledEvents ? { enabledEvents: patch.enabledEvents } : {}),
      ...(patch.scope ? { scope: patch.scope } : {}),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
    };
    // Manual disable leaves disabled_at and the reason empty; re-enabling clears failure history.
    if (patch.enabled === false) next = { ...next, status: 'disabled' };
    if (patch.enabled === true) next = { ...next, status: 'enabled', disabledReason: null, disabledAt: null, failingSince: null, warningSentAt: null };
    return this.save(next);
  }

  deleteEndpoint(ownerId: string, id: string): WebhookEndpoint {
    const endpoint = this.getEndpoint(ownerId, id);
    this.ctx.store.delete(C.webhookEndpoints, id);
    return endpoint;
  }

  /** Issues a new secret; the old one stays valid for `overlapMs`. */
  rotateSecret(ownerId: string, id: string, options: { readonly overlapMs: number; readonly secretFormat?: SecretFormat }): WebhookEndpoint {
    const current = this.getEndpoint(ownerId, id);
    const format = options.secretFormat ?? { prefix: 'whsec_' };
    const expiresAt = new Date(this.ctx.now().getTime() + options.overlapMs).toISOString();
    return this.save({
      ...current,
      secret: this.ctx.ids.secret(format.prefix, format),
      previousSecrets: options.overlapMs > 0 ? [...this.liveSecrets(current), { secret: current.secret, expiresAt }] : [],
    });
  }

  /** Current secret first, then previous secrets still inside their overlap window. */
  activeSecrets(endpoint: WebhookEndpoint): string[] {
    return [endpoint.secret, ...this.liveSecrets(endpoint).map((s) => s.secret)];
  }

  /** Whether the endpoint should receive this event (provider, scope, type, enabled). */
  wantsEvent(endpoint: WebhookEndpoint, event: Pick<ProviderWebhookEventRecord, 'providerId' | 'type' | 'ownerId'>): boolean {
    if (endpoint.status !== 'enabled' || endpoint.providerId !== event.providerId) return false;
    if (!endpoint.enabledEvents.includes('*') && !endpoint.enabledEvents.includes(event.type)) return false;
    const own = event.ownerId === endpoint.ownerId;
    const fromChild = isPlatformOwner(endpoint.ownerId) && !isPlatformOwner(event.ownerId) && platformOf(event.ownerId) === endpoint.ownerId;
    if (endpoint.scope === 'own') return own;
    if (endpoint.scope === 'connected') return fromChild;
    return own || fromChild;
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
      next = { ...next, status: 'disabled', disabledReason: 'consecutive_failures', disabledAt: now.toISOString() };
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

  findEvent(id: string): ProviderWebhookEventRecord | null {
    return this.ctx.store.get<ProviderWebhookEventRecord>(C.webhookEvents, id) ?? null;
  }

  listEvents(filter: { readonly providerId?: string; readonly ownerId?: string; readonly platformOwnerId?: string; readonly type?: string; readonly reference?: string } = {}): ProviderWebhookEventRecord[] {
    return this.ctx.store
      .list<ProviderWebhookEventRecord>(C.webhookEvents, (e) => {
        if (filter.providerId && e.providerId !== filter.providerId) return false;
        if (filter.ownerId && e.ownerId !== filter.ownerId) return false;
        if (filter.platformOwnerId && platformOf(e.ownerId) !== filter.platformOwnerId) return false;
        if (filter.type && e.type !== filter.type) return false;
        if (filter.reference && !e.references.includes(filter.reference)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  // Deliveries

  saveDelivery(delivery: WebhookDelivery): WebhookDelivery {
    this.ctx.store.put(C.webhookDeliveries, { ...delivery, updatedAt: this.ctx.nowIso() });
    return delivery;
  }

  findDelivery(id: string): WebhookDelivery | null {
    return this.ctx.store.get<WebhookDelivery>(C.webhookDeliveries, id) ?? null;
  }

  listDeliveries(filter: { readonly eventId?: string; readonly endpointId?: string } = {}): WebhookDelivery[] {
    return this.ctx.store
      .list<WebhookDelivery>(C.webhookDeliveries, (d) => (!filter.eventId || d.eventId === filter.eventId) && (!filter.endpointId || d.endpointId === filter.endpointId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.attempt - a.attempt);
  }

  nextAttemptNumber(eventId: string, endpointId: string): number {
    return this.listDeliveries({ eventId, endpointId }).reduce((max, d) => Math.max(max, d.attempt), 0) + 1;
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
