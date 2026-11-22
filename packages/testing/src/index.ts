import type { Sandbox } from '@mockrail/core';
import { startServer, type RunningServer, type ServerOptions } from '@mockrail/server';
import { ControlClient } from './control-client.js';
import { WebhookCollector } from './webhook-collector.js';

export { ControlClient } from './control-client.js';
export { WebhookCollector, type ReceivedWebhook, type Responder } from './webhook-collector.js';

export interface ApiResponse<T = Record<string, unknown>> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
}

export interface ApiRequestOptions {
  readonly headers?: Record<string, string>;
  readonly idempotencyKey?: string;
  /** Act as a connected account. */
  readonly account?: string;
  /** Force an outcome for this request, e.g. "fail:declined". */
  readonly scenario?: string;
}

/** Minimal client for a mounted provider API. Never throws on non-2xx; check `status`. */
export class ProviderClient {
  constructor(
    readonly baseUrl: string,
    readonly apiKey: string,
    private readonly accountHeader = 'X-Account-Id',
  ) {}

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown, options: ApiRequestOptions = {}): Promise<ApiResponse<T>> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        ...(options.account ? { [this.accountHeader]: options.account } : {}),
        ...(options.scenario ? { 'X-Mockrail-Scenario': options.scenario } : {}),
        ...options.headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as T };
  }

  get<T = Record<string, unknown>>(path: string, options?: ApiRequestOptions) {
    return this.request<T>('GET', path, undefined, options);
  }

  post<T = Record<string, unknown>>(path: string, body: unknown = {}, options?: ApiRequestOptions) {
    return this.request<T>('POST', path, body, options);
  }

  patch<T = Record<string, unknown>>(path: string, body: unknown, options?: ApiRequestOptions) {
    return this.request<T>('PATCH', path, body, options);
  }

  delete<T = Record<string, unknown>>(path: string, options?: ApiRequestOptions) {
    return this.request<T>('DELETE', path, undefined, options);
  }
}

export interface StartSandboxOptions extends Omit<ServerOptions, 'logger'> {
  /** API key used by `api()`. Default sk_sandbox_test. */
  readonly apiKey?: string;
  /** Log requests and deliveries to the console. Default false. */
  readonly verbose?: boolean;
}

export interface SandboxHarness {
  readonly url: string;
  readonly sandbox: Sandbox;
  readonly server: RunningServer;
  readonly control: ControlClient;
  /** Client for a mounted provider, e.g. `api('bachs').post('/v1/customers', {...})`. */
  api(providerId?: string): ProviderClient;
  /** Starts a local receiver and registers it as a webhook endpoint for the provider. */
  webhooks(options?: { provider?: string; events?: string[] }): Promise<WebhookCollector>;
  /** Shorthand for control.advance. */
  advance(by: string | number): ReturnType<ControlClient['advance']>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Starts an in-process sandbox on a free port. Defaults suit test suites: silent logs, no rate
 * limiting, and the clock frozen at the current time so nothing moves until you advance it.
 */
export async function startSandbox(options: StartSandboxOptions = {}): Promise<SandboxHarness> {
  const { apiKey = 'sk_sandbox_test', verbose = false, ...serverOptions } = options;
  const server = await startServer({
    port: 0,
    rateLimit: false,
    logRequests: verbose,
    frozenAt: new Date(),
    ...serverOptions,
    logger: verbose ? undefined : 'silent',
    ...(options.tickIntervalMs ? {} : { tickIntervalMs: 20 }),
  } as ServerOptions);
  const control = new ControlClient(server.url);
  const defaultProvider = [...server.adapters.keys()][0] ?? 'bachs';
  const collectors: WebhookCollector[] = [];

  return {
    url: server.url,
    sandbox: server.sandbox,
    server,
    control,
    api: (providerId = defaultProvider) => {
      const adapter = server.adapters.get(providerId);
      return new ProviderClient(`${server.url}/${providerId}`, apiKey, adapter?.auth.actingAccountHeader ?? 'X-Account-Id');
    },
    async webhooks(webhookOptions = {}) {
      const collector = await new WebhookCollector().listen();
      const endpoint = await control.registerWebhook({
        url: collector.url,
        provider: webhookOptions.provider ?? defaultProvider,
        ...(webhookOptions.events ? { enabled_events: webhookOptions.events } : {}),
      });
      collector.secret = endpoint.secret;
      collector.endpointId = endpoint.id;
      collectors.push(collector);
      return collector;
    },
    advance: (by) => control.advance(by),
    async reset() {
      await control.reset();
      for (const c of collectors) c.clear();
    },
    async close() {
      await Promise.all(collectors.map((c) => c.close()));
      await server.close();
    },
  };
}
