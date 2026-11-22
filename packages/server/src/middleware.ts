import { createHash } from 'node:crypto';
import { SandboxError, type AdapterResponse, type ProviderAdapter, type Sandbox } from '@mockrail/core';

// ---------------------------------------------------------------------------
// Rate limiting: fixed one-minute window per API key, on wall-clock time
// (it governs request throughput, not domain time, so the virtual clock does not apply).

interface Window {
  start: number;
  count: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly headers: Record<string, string>;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  check(adapter: ProviderAdapter, apiKey: string, now = Date.now()): RateLimitResult {
    const policy = adapter.rateLimit;
    const key = `${adapter.providerId}:${apiKey}`;
    let window = this.windows.get(key);
    if (!window || now - window.start >= policy.windowMs) {
      window = { start: now, count: 0 };
      this.windows.set(key, window);
    }
    window.count += 1;
    const resetAt = window.start + policy.windowMs;
    const allowed = window.count <= policy.limit;
    const headers: Record<string, string> = {
      [policy.headers.limit]: String(policy.limit),
      [policy.headers.remaining]: String(Math.max(0, policy.limit - window.count)),
      [policy.headers.reset]: String(Math.ceil(resetAt / 1000)),
    };
    if (!allowed) headers['Retry-After'] = String(Math.max(1, Math.ceil((resetAt - now) / 1000)));
    return { allowed, headers };
  }

  reset(): void {
    this.windows.clear();
  }
}

// ---------------------------------------------------------------------------
// Idempotency: keys scoped per provider, API key and acting account; only 2xx responses are
// cached, for the provider's TTL on the virtual clock. Stored in the sandbox store so
// snapshots and resets include them.

const COLLECTION = 'idempotency_keys';

interface IdempotencyRecord {
  readonly id: string;
  readonly state: 'in_progress' | 'done';
  readonly fingerprint: string;
  readonly response: AdapterResponse | null;
  readonly expiresAt: string;
}

export type IdempotencyBegin =
  | { readonly kind: 'proceed'; readonly recordId: string }
  | { readonly kind: 'replay'; readonly response: AdapterResponse };

export function beginIdempotent(
  sandbox: Sandbox,
  adapter: ProviderAdapter,
  scope: { readonly apiKey: string; readonly ownerId: string; readonly key: string },
  request: { readonly method: string; readonly path: string; readonly rawBody: string },
): IdempotencyBegin {
  const recordId = sha256(`${adapter.providerId}\n${scope.apiKey}\n${scope.ownerId}\n${scope.key}`);
  const fingerprint = sha256(`${request.method}\n${request.path}\n${canonicalBody(request.rawBody)}`);
  const now = sandbox.clock.now();
  const existing = sandbox.store.get<IdempotencyRecord>(COLLECTION, recordId);
  if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
    if (existing.fingerprint !== fingerprint) {
      throw new SandboxError('idempotency_conflict', 'This Idempotency-Key was already used with a different request body.');
    }
    if (existing.state === 'in_progress') {
      throw new SandboxError('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed. Retry shortly.');
    }
    if (existing.response) return { kind: 'replay', response: existing.response };
  }
  sandbox.store.put<IdempotencyRecord>(COLLECTION, {
    id: recordId,
    state: 'in_progress',
    fingerprint,
    response: null,
    expiresAt: new Date(now.getTime() + adapter.idempotency.ttlMs).toISOString(),
  });
  return { kind: 'proceed', recordId };
}

export function finishIdempotent(sandbox: Sandbox, adapter: ProviderAdapter, recordId: string, response: AdapterResponse | null): void {
  const record = sandbox.store.get<IdempotencyRecord>(COLLECTION, recordId);
  if (!record) return;
  if (response && response.status >= 200 && response.status < 300) {
    sandbox.store.put<IdempotencyRecord>(COLLECTION, {
      ...record,
      state: 'done',
      response,
      expiresAt: new Date(sandbox.clock.now().getTime() + adapter.idempotency.ttlMs).toISOString(),
    });
  } else {
    sandbox.store.delete(COLLECTION, recordId);
  }
}

function canonicalBody(raw: string): string {
  if (!raw.trim()) return '';
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)));
  } catch {
    return raw;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
