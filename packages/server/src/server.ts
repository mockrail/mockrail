import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore, Sandbox, SqliteStore, type FidelityMode, type ProviderAdapter, type Store } from '@mockrail/core';
import { createControlPlane } from './control-plane.js';
import { createGateway } from './gateway.js';
import { loadAdapters, type ProviderSpec } from './load-adapters.js';
import { consoleLogger, silentLogger, type Logger } from './logger.js';
import { RateLimiter } from './middleware.js';
import { parseScenarioFile } from './scenario-input.js';
import { WebhookDispatcher, type FetchLike } from './webhook-dispatcher.js';

export const VERSION = '0.1.0';

export interface ServerOptions {
  /** Port to listen on (0 = any free port). Default 4010. */
  readonly port?: number;
  readonly host?: string;
  /** Adapters to mount, by name or instance. Default ["bachs"]. */
  readonly providers?: readonly ProviderSpec[];
  /** 'memory' (default), 'sqlite', or a Store instance. */
  readonly store?: 'memory' | 'sqlite' | Store;
  /** SQLite file path when store is 'sqlite'. Default ./mockrail.db */
  readonly sqlitePath?: string;
  readonly fidelity?: FidelityMode;
  /** Seed for IDs and chaos (reproducible runs). */
  readonly seed?: number;
  /** Start with the virtual clock frozen at this time. */
  readonly frozenAt?: Date;
  /** Scenario file path or parsed content, loaded at start (for CI). */
  readonly scenarios?: string | unknown;
  /** Enforce the provider's rate limit. Default true. */
  readonly rateLimit?: boolean;
  /** Log each request. Default true. */
  readonly logRequests?: boolean;
  readonly logger?: Logger | 'silent';
  /** Base URL used in hosted checkout links. Defaults to the listening address. */
  readonly publicBaseUrl?: string;
  /** How often due jobs run on the running clock, in ms. Default 200. */
  readonly tickIntervalMs?: number;
  /** Override for webhook HTTP delivery (tests). */
  readonly fetch?: FetchLike;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly sandbox: Sandbox;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly dispatcher: WebhookDispatcher;
  readonly server: Server;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const logger = options.logger === 'silent' ? silentLogger : (options.logger ?? consoleLogger);
  const adapters = await loadAdapters(options.providers ?? ['bachs']);
  const store = typeof options.store === 'object' ? options.store : options.store === 'sqlite' ? new SqliteStore(options.sqlitePath ?? 'mockrail.db') : new MemoryStore();
  const sandbox = new Sandbox({
    store,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.frozenAt ? { frozenAt: options.frozenAt } : {}),
    config: { ...(options.fidelity ? { fidelity: options.fidelity } : {}) },
  });

  if (options.scenarios !== undefined) {
    const content = typeof options.scenarios === 'string' ? JSON.parse(readFileSync(options.scenarios, 'utf8')) : options.scenarios;
    const file = parseScenarioFile(content);
    if (file.fidelity) sandbox.setFidelity(file.fidelity);
    sandbox.scenarios.load(file);
  }

  const dispatcher = new WebhookDispatcher(sandbox, adapters, logger, options.fetch);
  dispatcher.start();
  const rateLimiter = new RateLimiter();
  const control = createControlPlane({ sandbox, adapters, dispatcher, rateLimiter, version: VERSION });
  const handler = createGateway({
    sandbox,
    adapters,
    control,
    rateLimiter,
    rateLimit: options.rateLimit ?? true,
    logger,
    logRequests: options.logRequests ?? true,
  });

  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4010, options.host ?? '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const host = options.host && options.host !== '0.0.0.0' ? options.host : '127.0.0.1';
  const url = `http://${host}:${address.port}`;
  sandbox.config.publicBaseUrl = options.publicBaseUrl ?? url;

  // Run due jobs on a ticker so timed behaviour (finalization, retries) happens on its own.
  let ticking = false;
  const ticker = setInterval(() => {
    if (ticking) return;
    ticking = true;
    sandbox.clock
      .runDue()
      .then((results) => results.filter((r) => !r.ok).forEach((r) => logger.warn(`job ${r.kind} failed: ${r.error}`)))
      .catch((error: unknown) => logger.error('scheduler tick failed', error))
      .finally(() => {
        ticking = false;
      });
  }, options.tickIntervalMs ?? 200);
  ticker.unref();

  return {
    url,
    port: address.port,
    sandbox,
    adapters,
    dispatcher,
    server,
    async close() {
      clearInterval(ticker);
      dispatcher.stop();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      sandbox.close();
    },
  };
}
