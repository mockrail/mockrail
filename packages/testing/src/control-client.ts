/** Typed client for the `/__sandbox/*` control plane. Works against a local or remote sandbox. */
export class ControlClient {
  constructor(private readonly baseUrl: string) {}

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}/__sandbox${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const data = text ? (JSON.parse(text) as T & { error?: string }) : ({} as T & { error?: string });
    if (!response.ok) throw new Error(`mockrail control ${method} ${path} failed (${response.status}): ${data.error ?? text}`);
    return data;
  }

  health() {
    return this.request('GET', '/health');
  }

  clock() {
    return this.request<{ now: string; frozen: boolean; pending_jobs: { id: string; kind: string; run_at: string }[] }>('GET', '/clock');
  }

  /** Advances virtual time, running every job that falls due, in order. `by` accepts "30d", "1h30m", or ms. */
  advance(by: string | number) {
    return this.request<{ now: string; jobs_run: number; failed: unknown[] }>('POST', '/clock/advance', { by });
  }

  advanceTo(to: Date | string) {
    return this.request<{ now: string; jobs_run: number }>('POST', '/clock/advance', { to: typeof to === 'string' ? to : to.toISOString() });
  }

  freeze(at?: Date | string) {
    return this.request('POST', '/clock/freeze', at ? { at: typeof at === 'string' ? at : at.toISOString() } : {});
  }

  unfreeze() {
    return this.request('POST', '/clock/unfreeze', {});
  }

  runDue() {
    return this.request<{ jobs_run: number }>('POST', '/clock/run-due', {});
  }

  /** Adds a rule, e.g. `{ match: { operation: 'payout.create' }, outcome: 'fail:bank_rejected', uses: 'unlimited' }`. */
  addScenario(rule: { match: Record<string, unknown>; outcome: unknown; uses?: number | 'unlimited'; description?: string }) {
    return this.request<{ id: string }>('POST', '/scenarios', rule);
  }

  loadScenarios(file: { fidelity?: 'sandbox' | 'live'; rules: unknown[] }) {
    return this.request('POST', '/scenarios', file);
  }

  clearScenarios() {
    return this.request('DELETE', '/scenarios');
  }

  setFidelity(mode: 'sandbox' | 'live') {
    return this.request('POST', '/fidelity', { mode });
  }

  /** Simulates a bank transfer into a virtual account. `amount` is a major-unit decimal string. */
  deposit(input: { account_number: string; amount: string; currency?: string; sender_name?: string; sender_account_number?: string; sender_bank_name?: string; reference?: string }) {
    return this.request<{ held: boolean; charge: { id: string } }>('POST', '/deposits', input);
  }

  releaseDeposit(paymentId: string) {
    return this.request('POST', `/deposits/${encodeURIComponent(paymentId)}/release`, {});
  }

  /** Pays a checkout session as the customer would on the hosted page. */
  payCheckout(checkoutId: string, input: { method?: 'card' | 'bank_transfer' | 'crypto' | 'mobile_money'; card_number?: string; amount_paid?: string; email?: string; name?: string; provider?: string } = {}) {
    return this.request<{ checkout: Record<string, unknown>; charge: Record<string, unknown> | null }>('POST', `/checkout/${encodeURIComponent(checkoutId)}/pay`, input);
  }

  endTrial(subscriptionId: string) {
    return this.request('POST', `/subscriptions/${encodeURIComponent(subscriptionId)}/end-trial`, {});
  }

  events(type?: string) {
    return this.request<{ items: { id: string; type: string; occurredAt: string; data: unknown }[] }>('GET', `/events${type ? `?type=${encodeURIComponent(type)}` : ''}`);
  }

  webhookEvents(filter: { provider?: string; type?: string } = {}) {
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    return this.request<{ items: { id: string; type: string; body: Record<string, unknown> }[] }>('GET', `/webhooks/events${qs ? `?${qs}` : ''}`);
  }

  deliveries(filter: { event_id?: string; endpoint_id?: string } = {}) {
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    return this.request<{ items: { id: string; attempt: number; status: string; kind: string; responseStatus: number | null }[] }>('GET', `/webhooks/deliveries${qs ? `?${qs}` : ''}`);
  }

  replayEvent(eventId: string, endpointId?: string) {
    return this.request('POST', `/webhooks/events/${encodeURIComponent(eventId)}/replay`, endpointId ? { endpoint_id: endpointId } : {});
  }

  registerWebhook(input: { url: string; provider?: string; enabled_events?: string[] }) {
    return this.request<{ id: string; secret: string; url: string }>('POST', '/webhooks/endpoints', input);
  }

  /** Inject delivery chaos: duplicates, drops, delays and reordering. */
  setChaos(chaos: { duplicate_rate?: number; drop_rate?: number; delay?: string | number; reorder_window?: string | number }) {
    return this.request('POST', '/webhooks/chaos', chaos);
  }

  balances(owner = 'platform') {
    return this.request('GET', `/balances?owner=${encodeURIComponent(owner)}`);
  }

  reset() {
    return this.request('POST', '/reset', {});
  }

  snapshot() {
    return this.request<{ id: string }>('POST', '/snapshots', {});
  }

  restore(snapshotId: string) {
    return this.request('POST', `/snapshots/${encodeURIComponent(snapshotId)}/restore`, {});
  }
}
