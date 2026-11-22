import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  isSandboxError,
  parseDuration,
  platformOwner,
  SandboxError,
  type AdapterResponse,
  type HttpMethod,
  type ProviderAdapter,
  type RouteDefinition,
  type Sandbox,
  type ScenarioOutcome,
} from '@mockrail/core';
import { CONTROL_PREFIX, type ControlRequest, type ControlResult } from './control-plane.js';
import { lowerHeaders, parseJsonBody, readRawBody, send, sendHtml } from './http.js';
import type { Logger } from './logger.js';
import { beginIdempotent, finishIdempotent, type RateLimiter } from './middleware.js';
import { Router } from './router.js';
import { parseOutcome } from './scenario-input.js';

/** Per-request testing headers, shared by every provider. */
export const MOCKRAIL_HEADERS = {
  /** Force the outcome of the operation this request triggers, e.g. `fail:declined`. `rate_limited` returns a 429. */
  scenario: 'x-mockrail-scenario',
  /** Wait this long (wall time) before handling, e.g. `2s`; useful for idempotency races. */
  latency: 'x-mockrail-latency',
} as const;

export interface GatewayOptions {
  readonly sandbox: Sandbox;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly control: Router<(req: ControlRequest) => ControlResult | Promise<ControlResult>>;
  readonly rateLimiter: RateLimiter;
  readonly rateLimit: boolean;
  readonly logger: Logger;
  readonly logRequests: boolean;
}

export function createGateway(options: GatewayOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const { sandbox, adapters, logger } = options;
  const routers = new Map<string, Router<RouteDefinition>>();
  for (const adapter of adapters.values()) {
    const router = new Router<RouteDefinition>();
    for (const route of adapter.routes) router.add(route.method, route.path, route);
    routers.set(adapter.providerId, router);
  }

  return (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const requestId = randomUUID();
    const finish = (status: number): void => {
      if (options.logRequests) logger.info(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms ${requestId}`);
    };

    const handle = async (): Promise<void> => {
      if (url.pathname === '/' && req.method === 'GET') {
        send(res, 200, { name: 'mockrail', control: `${CONTROL_PREFIX}/health`, providers: [...adapters.keys()].map((p) => `/${p}`) });
        return finish(200);
      }
      if (url.pathname === CONTROL_PREFIX || url.pathname.startsWith(`${CONTROL_PREFIX}/`)) {
        return finish(await handleControl(req, res, url, options));
      }
      const [, providerId = '', ...rest] = url.pathname.split('/');
      const adapter = adapters.get(providerId);
      if (!adapter) {
        send(res, 404, { error: `No provider mounted at /${providerId}. Mounted: ${[...adapters.keys()].map((p) => `/${p}`).join(', ')}` });
        return finish(404);
      }
      const status = await handleProvider(req, res, url, `/${rest.join('/')}`, adapter, routers.get(providerId) as Router<RouteDefinition>, requestId, options);
      finish(status);
    };

    handle().catch((error: unknown) => {
      logger.error(`unhandled error for ${req.method} ${url.pathname}`, error);
      send(res, 500, { error: 'Internal sandbox error' });
      finish(500);
    });
  };

  async function handleProvider(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    adapter: ProviderAdapter,
    router: Router<RouteDefinition>,
    requestId: string,
    opts: GatewayOptions,
  ): Promise<number> {
    const baseHeaders: Record<string, string> = { [adapter.requestIdHeader]: requestId };
    const reply = (response: AdapterResponse, extra: Record<string, string> = {}): number => {
      send(res, response.status, response.body, { ...baseHeaders, ...extra, ...(response.headers ?? {}) });
      return response.status;
    };
    const fail = (error: unknown, extra: Record<string, string> = {}): number => {
      const sandboxError = isSandboxError(error) ? error : new SandboxError('internal', 'An unexpected error occurred in the sandbox.');
      if (!isSandboxError(error)) logger.error(`route error ${req.method} ${url.pathname}`, error);
      return reply(adapter.renderError(sandboxError), extra);
    };

    const method = (req.method ?? 'GET').toUpperCase() as HttpMethod;
    const match = router.match(method, path);
    if (!match) return fail(new SandboxError('not_found', `No route for ${method} ${path}.`));
    if (match === 'method_not_allowed') return fail(new SandboxError('bad_request', `${method} is not supported on ${path}.`, { status: 405 }));

    const headers = lowerHeaders(req);
    const auth = adapter.auth.authenticate(headers);
    if (!auth.ok) return fail(auth.error);

    let rateHeaders: Record<string, string> = {};
    if (opts.rateLimit) {
      const limit = opts.rateLimiter.check(adapter, auth.apiKey);
      rateHeaders = limit.headers;
      if (!limit.allowed) return fail(new SandboxError('rate_limited', 'Too many requests. Retry after the time in Retry-After.'), rateHeaders);
    }

    let idempotencyRecord: string | null = null;
    try {
      const scenarioHeader = headers[MOCKRAIL_HEADERS.scenario];
      if (scenarioHeader?.trim() === 'rate_limited') {
        const policy = adapter.rateLimit;
        return fail(new SandboxError('rate_limited', 'Rate limited (forced by X-Mockrail-Scenario).'), {
          ...rateHeaders,
          [policy.headers.limit]: String(policy.limit),
          [policy.headers.remaining]: '0',
          'Retry-After': '1',
        });
      }
      const scenarioOverride: ScenarioOutcome | undefined = scenarioHeader ? parseOutcome(scenarioHeader) : undefined;

      const actingHeader = adapter.auth.actingAccountHeader;
      const acting = actingHeader ? headers[actingHeader] : undefined;
      const platform = platformOwner(adapter.providerId);
      let ownerId = platform;
      if (acting) {
        // Unknown, foreign and non-child accounts all get the same 403 naming the header and id.
        const account = sandbox.accounts.find(acting);
        if (!account || account.platformOwnerId !== platform) {
          throw new SandboxError('forbidden', `This key cannot act as the account in ${actingHeader}: ${acting}.`);
        }
        ownerId = sandbox.accounts.ownerOf(account);
      }

      const rawBody = method === 'GET' || method === 'DELETE' ? '' : await readRawBody(req);
      const body = parseJsonBody(rawBody, headers['content-type']);

      const idempotent = match.value.idempotent ?? adapter.idempotency.methods.includes(method);
      const key = headers[adapter.idempotency.header.toLowerCase()];
      if (idempotent && key) {
        const begin = beginIdempotent(sandbox, adapter, { apiKey: auth.apiKey, ownerId, key }, { method, path, rawBody });
        if (begin.kind === 'replay') return reply(begin.response, { ...rateHeaders, 'Idempotent-Replayed': 'true' });
        idempotencyRecord = begin.recordId;
      }

      const latency = headers[MOCKRAIL_HEADERS.latency];
      if (latency) await new Promise((resolve) => setTimeout(resolve, Math.min(parseDuration(latency), 30_000)));

      const response = await match.value.handler({
        method,
        path,
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        headers,
        body,
        sandbox,
        ownerId,
        apiKey: auth.apiKey,
        requestId,
        ...(scenarioOverride ? { scenarioOverride } : {}),
      });
      if (idempotencyRecord) finishIdempotent(sandbox, adapter, idempotencyRecord, response);
      return reply(response, rateHeaders);
    } catch (error) {
      if (idempotencyRecord) finishIdempotent(sandbox, adapter, idempotencyRecord, null);
      return fail(error, rateHeaders);
    }
  }
}

async function handleControl(req: IncomingMessage, res: ServerResponse, url: URL, options: GatewayOptions): Promise<number> {
  const method = (req.method ?? 'GET').toUpperCase();
  const match = options.control.match(method, url.pathname);
  if (!match || match === 'method_not_allowed') {
    send(res, 404, { error: `No control endpoint for ${method} ${url.pathname}.` });
    return 404;
  }
  try {
    const raw = method === 'GET' ? '' : await readRawBody(req);
    const parsed = parseJsonBody(raw, req.headers['content-type']);
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : Array.isArray(parsed) ? { rules: parsed } : {};
    const result = await match.value({ params: match.params, query: Object.fromEntries(url.searchParams), body });
    if ('html' in result) {
      sendHtml(res, result.status ?? 200, result.html);
      return result.status ?? 200;
    }
    send(res, result.status, result.body);
    return result.status;
  } catch (error) {
    if (isSandboxError(error)) {
      send(res, error.status, { error: error.message, code: error.code, errors: error.fieldErrors, details: error.details });
      return error.status;
    }
    options.logger.error(`control error ${method} ${url.pathname}`, error);
    send(res, 500, { error: (error as Error).message ?? 'Internal error' });
    return 500;
  }
}
