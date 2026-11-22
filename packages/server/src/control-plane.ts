import {
  isCurrencyCode,
  notFound,
  parseDecimal,
  parseDuration,
  ownerId as makeOwner,
  platformOwner,
  providerOf,
  type EndpointScope,
  SandboxError,
  type PaymentMethod,
  type ProviderAdapter,
  type Sandbox,
  type SandboxSnapshot,
  type ScheduledJobResult,
} from '@mockrail/core';
import { renderCheckoutPage } from './checkout-page.js';
import type { RateLimiter } from './middleware.js';
import { Router } from './router.js';
import { parseRule, parseScenarioFile } from './scenario-input.js';
import type { WebhookDispatcher } from './webhook-dispatcher.js';

export const CONTROL_PREFIX = '/__sandbox';

export interface ControlContext {
  readonly sandbox: Sandbox;
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly dispatcher: WebhookDispatcher;
  readonly rateLimiter: RateLimiter;
  readonly version: string;
}

export interface ControlRequest {
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

export type ControlResult = { readonly status: number; readonly body: unknown } | { readonly html: string; readonly status?: number };

type Handler = (req: ControlRequest) => ControlResult | Promise<ControlResult>;

const ok = (body: unknown): ControlResult => ({ status: 200, body });

/** The `/__sandbox/*` API. Never mixed into provider routes; no authentication (local tool). */
export function createControlPlane(ctx: ControlContext): Router<Handler> {
  const { sandbox, adapters, dispatcher } = ctx;
  const router = new Router<Handler>();
  const snapshots = new Map<string, SandboxSnapshot>();
  const on = (method: string, path: string, handler: Handler): void => router.add(method, `${CONTROL_PREFIX}${path}`, handler);

  const clockState = () => ({
    now: sandbox.clock.now().toISOString(),
    frozen: sandbox.clock.isFrozen(),
    pending_jobs: sandbox.scheduler.pending().map((j) => ({ id: j.id, kind: j.kind, run_at: j.runAt })),
  });
  const summarize = (results: readonly ScheduledJobResult[]) => ({
    jobs_run: results.length,
    failed: results.filter((r) => !r.ok).map((r) => ({ kind: r.kind, run_at: r.runAt, error: r.error })),
  });
  /** Owner for `?provider=&account=` (defaults: first provider, its platform). */
  const ownerFor = (q: Readonly<Record<string, unknown>>): string => {
    const adapter = pickAdapter(q.provider);
    return typeof q.account === 'string' && q.account ? makeOwner(adapter.providerId, q.account) : platformOwner(adapter.providerId);
  };
  const pickAdapter = (providerId?: unknown): ProviderAdapter => {
    const adapter = typeof providerId === 'string' && providerId ? adapters.get(providerId) : adapters.values().next().value;
    if (!adapter) throw new SandboxError('bad_request', `Unknown provider '${String(providerId)}'. Loaded: ${[...adapters.keys()].join(', ')}.`);
    return adapter;
  };

  // Health and info

  on('GET', '/health', () =>
    ok({
      ok: true,
      name: 'mockrail',
      version: ctx.version,
      providers: [...adapters.values()].map((a) => ({ id: a.providerId, name: a.displayName, mount: `/${a.providerId}` })),
      fidelity: sandbox.config.fidelity,
      now: sandbox.clock.now().toISOString(),
      frozen: sandbox.clock.isFrozen(),
    }),
  );

  // Clock

  on('GET', '/clock', () => ok(clockState()));

  on('POST', '/clock/advance', async ({ body }) => {
    let results: readonly ScheduledJobResult[];
    if (body.to) {
      const to = new Date(String(body.to));
      if (Number.isNaN(to.getTime())) throw new SandboxError('bad_request', `'${String(body.to)}' is not a valid date.`);
      results = await sandbox.clock.advanceTo(to);
    } else {
      if (body.by === undefined) throw new SandboxError('bad_request', 'Provide "by" (e.g. "30d") or "to" (an ISO date).');
      let ms: number;
      try {
        ms = parseDuration(body.by as string | number);
      } catch (error) {
        throw new SandboxError('bad_request', (error as Error).message);
      }
      results = await sandbox.clock.advanceBy({ milliseconds: ms });
    }
    return ok({ ...clockState(), ...summarize(results) });
  });

  on('POST', '/clock/freeze', ({ body }) => {
    const at = body.at ? new Date(String(body.at)) : undefined;
    if (at && Number.isNaN(at.getTime())) throw new SandboxError('bad_request', `'${String(body.at)}' is not a valid date.`);
    sandbox.clock.freeze(at);
    return ok(clockState());
  });

  on('POST', '/clock/unfreeze', () => {
    sandbox.clock.unfreeze();
    return ok(clockState());
  });

  on('POST', '/clock/run-due', async () => ok({ ...clockState(), ...summarize(await sandbox.clock.runDue()) }));

  // Scenarios and fidelity

  on('GET', '/scenarios', () => ok({ fidelity: sandbox.config.fidelity, rules: sandbox.scenarios.list() }));

  on('POST', '/scenarios', ({ body }) => {
    if (Array.isArray(body.rules)) {
      const file = parseScenarioFile(body);
      if (file.fidelity) sandbox.setFidelity(file.fidelity);
      return { status: 201, body: { fidelity: sandbox.config.fidelity, rules: sandbox.scenarios.load(file) } };
    }
    return { status: 201, body: sandbox.scenarios.addRule(parseRule(body)) };
  });

  on('DELETE', '/scenarios', () => {
    sandbox.scenarios.clear();
    return ok({ rules: [] });
  });

  on('DELETE', '/scenarios/:id', ({ params }) => {
    if (!sandbox.scenarios.removeRule(params.id ?? '')) throw notFound('scenario rule', params.id ?? '');
    return ok({ id: params.id, deleted: true });
  });

  on('POST', '/fidelity', ({ body }) => {
    if (body.mode !== 'sandbox' && body.mode !== 'live') throw new SandboxError('bad_request', 'mode must be "sandbox" or "live".');
    sandbox.setFidelity(body.mode);
    return ok({ fidelity: sandbox.config.fidelity });
  });

  // Virtual-account deposits

  on('POST', '/deposits', ({ body }) => {
    const accountNumber = String(body.account_number ?? '');
    const account = sandbox.virtualAccounts.findByNumber(accountNumber);
    if (!account) throw notFound('virtual account', accountNumber);
    const currency = String(body.currency ?? account.currency).toUpperCase();
    if (!isCurrencyCode(currency)) throw new SandboxError('bad_request', `Unsupported currency '${currency}'.`);
    const minor = body.amount_minor !== undefined ? BigInt(String(body.amount_minor)) : parseDecimal(body.amount, currency);
    if (minor === null) throw new SandboxError('bad_request', 'Provide amount (major-unit decimal, e.g. "15000.00") or amount_minor.');
    const charge = sandbox.virtualAccounts.simulateDeposit({
      accountNumber,
      amount: { amountMinor: minor, currency },
      senderName: (body.sender_name as string | undefined) ?? null,
      senderAccountNumber: (body.sender_account_number as string | undefined) ?? null,
      senderBankName: (body.sender_bank_name as string | undefined) ?? null,
      reference: (body.reference as string | undefined) ?? null,
    });
    return { status: 201, body: { held: charge.settlement === 'held', charge } };
  });

  on('POST', '/deposits/:payment_id/release', ({ params }) => ok({ charge: sandbox.charges.releaseHeld(params.payment_id ?? '') }));

  // Hosted checkout

  on('GET', '/checkout/:id', ({ params, query }) => {
    const session = sandbox.checkout.find(params.id);
    if (!session) return { status: 404, html: '<!doctype html><title>Not found</title><p>Checkout session not found.</p>' };
    const adapter = pickAdapter(query.provider || providerOf(session.ownerId));
    return { html: renderCheckoutPage({ session, providerId: adapter.providerId, providerName: adapter.displayName, testCards: adapter.testCards ?? [] }) };
  });

  on('POST', '/checkout/:id/pay', ({ params, body }) => {
    const session = sandbox.checkout.find(params.id);
    if (!session) throw notFound('checkout session', params.id ?? '');
    const adapter = pickAdapter(body.provider || providerOf(session.ownerId));
    const method = (body.method ?? 'card') as PaymentMethod['type'];
    if (!['card', 'bank_transfer', 'crypto', 'mobile_money'].includes(method)) throw new SandboxError('bad_request', `Unknown payment method '${method}'.`);
    const paidMinor = body.amount_paid !== undefined && body.amount_paid !== '' ? parseDecimal(body.amount_paid, session.amount.currency) : undefined;
    if (paidMinor === null) throw new SandboxError('bad_request', 'amount_paid is not a valid amount.');
    const simulated = adapter.simulatePayment
      ? adapter.simulatePayment(
          { method, ...(typeof body.card_number === 'string' ? { cardNumber: body.card_number } : {}), ...(paidMinor !== undefined ? { amountPaidMinor: paidMinor } : {}) },
          { currency: session.amount.currency, amountMinor: session.amount.amountMinor },
        )
      : { paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'sandbox' } as PaymentMethod };
    const result = sandbox.checkout.pay(session.id, {
      paymentMethod: simulated.paymentMethod,
      customerEmail: typeof body.email === 'string' ? body.email : null,
      customerName: typeof body.name === 'string' ? body.name : null,
      ...(simulated.outcomeOverride ? { outcomeOverride: simulated.outcomeOverride } : {}),
      ...(simulated.futureOutcome ? { futureOutcome: simulated.futureOutcome } : {}),
      ...(simulated.feeRule !== undefined ? { feeRule: simulated.feeRule } : {}),
    });
    return ok(result);
  });

  // Billing

  on('POST', '/subscriptions/:id/end-trial', ({ params }) => ok({ subscription: sandbox.subscriptions.endTrial(params.id ?? '') }));

  /** Approve or reject a payout destination waiting for review (live fidelity). */
  on('POST', '/payout-destinations/:id/review', ({ params, body }) => {
    const decision = body.decision === 'rejected' ? 'rejected' : body.decision === 'approved' ? 'approved' : null;
    if (!decision) throw new SandboxError('bad_request', 'decision must be "approved" or "rejected".');
    return ok({ destination: sandbox.payouts.reviewDestination(params.id ?? '', decision, typeof body.reason === 'string' ? body.reason : null) });
  });

  // Events and webhooks

  on('GET', '/events', ({ query }) =>
    ok({ items: sandbox.events.list({ ...(query.type ? { type: query.type } : {}), ...(query.account || query.provider ? { ownerId: ownerFor(query) } : {}) }) }),
  );

  on('GET', '/webhooks/events', ({ query }) =>
    ok({ items: sandbox.webhooks.listEvents({ ...(query.provider ? { providerId: query.provider } : {}), ...(query.type ? { type: query.type } : {}) }) }),
  );

  on('POST', '/webhooks/events/:id/replay', ({ params, body }) => {
    const event = sandbox.webhooks.findEvent(params.id ?? '');
    if (!event) throw notFound('webhook event', params.id ?? '');
    const deliveries = sandbox.webhooks.requestRedelivery({ eventId: event.id, kind: 'replay', ...(typeof body.endpoint_id === 'string' ? { endpointId: body.endpoint_id } : {}) });
    return ok({ event_id: event.id, deliveries });
  });

  on('GET', '/webhooks/deliveries', ({ query }) =>
    ok({ items: sandbox.webhooks.listDeliveries({ ...(query.event_id ? { eventId: query.event_id } : {}), ...(query.endpoint_id ? { endpointId: query.endpoint_id } : {}) }) }),
  );

  on('GET', '/webhooks/endpoints', ({ query }) => {
    const providers = query.provider ? [query.provider] : [...adapters.keys()];
    return ok({ items: providers.flatMap((p) => sandbox.webhooks.listEndpoints({ providerId: p })) });
  });

  /** Registers an endpoint without going through a provider's API (used by @mockrail/testing). */
  on('POST', '/webhooks/endpoints', ({ body }) => {
    const adapter = pickAdapter(body.provider);
    const endpoint = sandbox.webhooks.createEndpoint({
      providerId: adapter.providerId,
      ownerId: platformOwner(adapter.providerId),
      url: String(body.url ?? ''),
      enabledEvents: Array.isArray(body.enabled_events) ? (body.enabled_events as string[]) : ['*'],
      name: typeof body.name === 'string' ? body.name : 'registered via control plane',
      ...(adapter.webhookSecretFormat ? { secretFormat: adapter.webhookSecretFormat } : {}),
      // Receives the platform's and its connected accounts' events unless told otherwise.
      scope: ({ account: 'own', connect: 'connected', all: 'all' } as Record<string, EndpointScope>)[String(body.event_source ?? 'all')] ?? 'all',
    });
    return { status: 201, body: endpoint };
  });

  on('GET', '/webhooks/chaos', () => ok(dispatcher.getChaos()));

  on('POST', '/webhooks/chaos', ({ body }) => {
    const num = (snake: string, camel: string): number | undefined => {
      const v = body[snake] ?? body[camel];
      if (v === undefined) return undefined;
      return typeof v === 'string' && /[a-z]/i.test(v) ? parseDuration(v) : Number(v);
    };
    return ok(
      dispatcher.setChaos({
        ...optional('duplicateRate', num('duplicate_rate', 'duplicateRate')),
        ...optional('dropRate', num('drop_rate', 'dropRate')),
        ...optional('delayMs', num('delay', 'delayMs')),
        ...optional('reorderWindowMs', num('reorder_window', 'reorderWindowMs')),
      }),
    );
  });

  // Ledger

  on('GET', '/balances', ({ query }) => ok({ owner: ownerFor(query), balances: sandbox.ledger.balancesFor(ownerFor(query)) }));

  on('GET', '/ledger', ({ query }) =>
    ok({
      entries: sandbox.ledger.entries({ ...(query.account || query.provider ? { ownerId: ownerFor(query) } : {}), ...(query.reference ? { reference: query.reference } : {}) }),
      trial_balance: Object.fromEntries(sandbox.ledger.trialBalance()),
    }),
  );

  // State

  on('POST', '/reset', () => {
    sandbox.reset();
    ctx.rateLimiter.reset();
    return ok({ reset: true, ...clockState() });
  });

  on('POST', '/snapshots', () => {
    const id = sandbox.ids.next('snap');
    snapshots.set(id, sandbox.snapshot());
    return { status: 201, body: { id } };
  });

  on('POST', '/snapshots/:id/restore', ({ params }) => {
    const snapshot = snapshots.get(params.id ?? '');
    if (!snapshot) throw notFound('snapshot', params.id ?? '');
    sandbox.restore(snapshot);
    return ok({ restored: params.id, ...clockState() });
  });

  // Stub pages behind Connect account links
  on('GET', '/connect/:kind/:account_id', ({ params }) => ({
    html: `<!doctype html><meta charset="utf-8"><title>Sandbox ${params.kind}</title><body style="font-family:system-ui;padding:24px"><p>Sandbox ${params.kind} page for <code>${(params.account_id ?? '').replace(/[^\w-]/g, '')}</code>. Nothing to do here: sandbox accounts are active immediately.</p></body>`,
  }));

  return router;
}

function optional<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}
