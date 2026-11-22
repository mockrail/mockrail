import type {
  DeliveryKind,
  DomainEvent,
  ProviderAdapter,
  ProviderWebhookEventRecord,
  Sandbox,
  WebhookDelivery,
  WebhookEndpoint,
} from '@mockrail/core';
import type { Logger } from './logger.js';

export interface ChaosConfig {
  /** Probability (0-1) that a delivery is sent twice. */
  readonly duplicateRate: number;
  /** Probability (0-1) that an automatic delivery attempt is silently dropped. */
  readonly dropRate: number;
  /** Fixed extra delay before each delivery, in ms of virtual time. */
  readonly delayMs: number;
  /** Random extra delay in [0, reorderWindowMs), so events can arrive out of order. */
  readonly reorderWindowMs: number;
}

export const NO_CHAOS: ChaosConfig = { duplicateRate: 0, dropRate: 0, delayMs: 0, reorderWindowMs: 0 };

const DELIVER_JOB = 'webhook.deliver';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number }>;

/**
 * Turns domain events into provider webhooks: each adapter maps the event, the dispatcher stores
 * the provider event, then schedules one delivery job per subscribed endpoint on the virtual clock.
 * Retries follow the adapter's delivery policy, so advancing the clock runs them.
 */
export class WebhookDispatcher {
  private chaos: ChaosConfig = NO_CHAOS;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly sandbox: Sandbox,
    private readonly adapters: ReadonlyMap<string, ProviderAdapter>,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {}

  start(): void {
    this.sandbox.scheduler.register<{ deliveryId: string }>(DELIVER_JOB, ({ deliveryId }) => this.deliver(deliveryId));
    this.unsubscribe = this.sandbox.events.subscribe((event) => this.onDomainEvent(event));
    this.sandbox.webhooks.setRedeliveryHandler((request) => {
      const event = this.sandbox.webhooks.findEvent(request.eventId);
      if (!event) return [];
      return this.endpointsFor(event, request.endpointId).map((endpoint) => this.schedule(event, endpoint, 1, request.kind, 0));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.sandbox.webhooks.setRedeliveryHandler(null);
  }

  getChaos(): ChaosConfig {
    return this.chaos;
  }

  setChaos(chaos: Partial<ChaosConfig>): ChaosConfig {
    const clamp = (n: number | undefined, fallback: number, max = Number.POSITIVE_INFINITY): number =>
      n === undefined || !Number.isFinite(n) ? fallback : Math.min(Math.max(n, 0), max);
    this.chaos = {
      duplicateRate: clamp(chaos.duplicateRate, this.chaos.duplicateRate, 1),
      dropRate: clamp(chaos.dropRate, this.chaos.dropRate, 1),
      delayMs: clamp(chaos.delayMs, this.chaos.delayMs),
      reorderWindowMs: clamp(chaos.reorderWindowMs, this.chaos.reorderWindowMs),
    };
    return this.chaos;
  }

  private onDomainEvent(event: DomainEvent): void {
    for (const adapter of this.adapters.values()) {
      for (const mapped of adapter.mapDomainEvent(event, this.sandbox)) {
        const record = this.sandbox.webhooks.recordEvent({
          id: mapped.id,
          providerId: adapter.providerId,
          type: mapped.type,
          ownerId: mapped.ownerId,
          domainEventId: event.id,
          body: mapped.body,
          createdAt: mapped.createdAt,
        });
        for (const endpoint of this.endpointsFor(record)) {
          const extra = this.chaos.delayMs + (this.chaos.reorderWindowMs > 0 ? this.sandbox.random.int(this.chaos.reorderWindowMs) : 0);
          this.schedule(record, endpoint, 1, 'automatic', extra);
          if (this.chaos.duplicateRate > 0 && this.sandbox.random.next() < this.chaos.duplicateRate) {
            this.schedule(record, endpoint, 1, 'duplicate', extra + (this.chaos.reorderWindowMs > 0 ? this.sandbox.random.int(this.chaos.reorderWindowMs) : 0));
          }
        }
      }
    }
  }

  private endpointsFor(event: ProviderWebhookEventRecord, endpointId?: string): WebhookEndpoint[] {
    return this.sandbox.webhooks
      .listEndpoints(event.providerId)
      .filter((e) => (endpointId ? e.id === endpointId : this.sandbox.webhooks.wantsEvent(e, event.type)));
  }

  private schedule(event: ProviderWebhookEventRecord, endpoint: WebhookEndpoint, attempt: number, kind: DeliveryKind, delayMs: number): WebhookDelivery {
    const now = this.sandbox.clock.now();
    const runAt = new Date(now.getTime() + delayMs);
    const delivery = this.sandbox.webhooks.saveDelivery({
      id: this.sandbox.ids.next('whd'),
      providerId: event.providerId,
      eventId: event.id,
      endpointId: endpoint.id,
      attempt,
      kind,
      status: 'scheduled',
      responseStatus: null,
      error: null,
      durationMs: null,
      scheduledFor: runAt.toISOString(),
      attemptedAt: null,
      createdAt: now.toISOString(),
    });
    this.sandbox.scheduler.schedule(DELIVER_JOB, runAt, { deliveryId: delivery.id });
    return delivery;
  }

  private async deliver(deliveryId: string): Promise<void> {
    const delivery = this.sandbox.webhooks.findDelivery(deliveryId);
    if (!delivery) return;
    const adapter = this.adapters.get(delivery.providerId);
    const event = this.sandbox.webhooks.findEvent(delivery.eventId);
    const endpoint = this.sandbox.webhooks.findEndpoint(delivery.endpointId);
    const attemptedAt = this.sandbox.clock.now().toISOString();
    if (!adapter || !event || !endpoint || endpoint.status !== 'enabled') {
      this.sandbox.webhooks.saveDelivery({ ...delivery, status: 'failed', error: 'endpoint missing or disabled', attemptedAt });
      return;
    }
    if (delivery.kind === 'automatic' && this.chaos.dropRate > 0 && this.sandbox.random.next() < this.chaos.dropRate) {
      this.sandbox.webhooks.saveDelivery({ ...delivery, status: 'dropped', error: 'dropped by chaos', attemptedAt });
      this.logger.info(`webhook ${event.type} ${event.id} -> ${endpoint.url} dropped (chaos)`);
      return;
    }

    const policy = adapter.deliveryPolicy;
    const rawBody = JSON.stringify(event.body);
    // Signatures use wall-clock time so receivers' timestamp tolerance checks pass even after the
    // virtual clock has been advanced. The envelope's created_at stays on virtual time.
    const signatureHeaders = adapter.webhookSigner.sign({
      rawBody,
      timestamp: new Date(),
      secrets: this.sandbox.webhooks.activeSecrets(endpoint),
    });
    const started = Date.now();
    let status: number | undefined;
    let error: string | undefined;
    try {
      const response = await this.fetchImpl(endpoint.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'mockrail-webhooks/0.1', ...signatureHeaders },
        body: rawBody,
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
      status = response.status;
    } catch (err) {
      const name = (err as { name?: string })?.name;
      error = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'connection_error';
    }
    const durationMs = Date.now() - started;
    const succeeded = status !== undefined && policy.isSuccess(status);
    this.sandbox.webhooks.saveDelivery({
      ...delivery,
      status: succeeded ? 'succeeded' : 'failed',
      responseStatus: status ?? null,
      error: error ?? null,
      durationMs,
      attemptedAt,
    });
    this.logger.info(`webhook ${event.type} ${event.id} -> ${endpoint.url} attempt ${delivery.attempt} ${succeeded ? 'ok' : 'failed'} (${status ?? error}) ${durationMs}ms`);

    if (succeeded) {
      this.sandbox.webhooks.recordSuccess(endpoint.id);
      return;
    }
    const health = this.sandbox.webhooks.recordFailure(endpoint.id, policy.autoDisable);
    if (health.warned) this.logger.warn(`webhook endpoint ${endpoint.id} has failed for 24h+; a warning email would be sent`);
    if (health.disabled) this.logger.warn(`webhook endpoint ${endpoint.id} disabled: consecutive_failures`);

    // Resends, replays and duplicates are single attempts; automatic deliveries retry per policy.
    const result = { ...(status !== undefined ? { status } : {}), ...(error ? { error } : {}) };
    if (delivery.kind === 'automatic' && delivery.attempt < policy.maxAttempts && policy.isRetryable(result) && !health.disabled) {
      const wait = policy.retryDelaysMs[delivery.attempt - 1] ?? policy.retryDelaysMs[policy.retryDelaysMs.length - 1] ?? 60_000;
      this.schedule(event, endpoint, delivery.attempt + 1, 'automatic', wait);
    }
  }
}
