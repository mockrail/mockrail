import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyBachsSignature } from '@mockrail/adapter-bachs';
import { startSandbox, type ProviderClient, type SandboxHarness, type WebhookCollector } from '@mockrail/testing';

let sb: SandboxHarness;
let api: ProviderClient;
let hooks: WebhookCollector;

beforeAll(async () => {
  sb = await startSandbox({ seed: 7 });
  api = sb.api('bachs');
});

beforeEach(async () => {
  await sb.reset();
  await sb.control.freeze(new Date());
  hooks = await sb.webhooks();
});

afterAll(async () => {
  await sb.close();
});

type Json = Record<string, any>;

async function recurringCheckout(price = '29.00', trialDays = 0): Promise<{ checkoutId: string; productId: string }> {
  const product = await api.post<Json>('/v1/products', {
    name: 'Pro plan',
    price,
    currency: 'USD',
    recurring: { interval: 'month', interval_count: 1, trial_days: trialDays },
  });
  expect(product.status).toBe(201);
  const checkout = await api.post<Json>('/v1/checkout-sessions', { product_id: product.body.id, customer_email: 'ada@example.com' });
  expect(checkout.status).toBe(201);
  return { checkoutId: checkout.body.id, productId: product.body.id };
}

describe('wire conventions', () => {
  it('rejects missing and live keys with the Bachs error shape and a request id', async () => {
    const res = await fetch(`${sb.url}/bachs/v1/customers`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toMatch(/^req_/);
    const body = (await res.json()) as Json;
    expect(body).toMatchObject({ error_code: 'UNAUTHORIZED', errors: [], details: {} });
    expect(typeof body.detail).toBe('string');

    const live = await fetch(`${sb.url}/bachs/v1/customers`, { headers: { authorization: 'Bearer sk_live_abc' } });
    expect(live.status).toBe(401);
  });

  it('formats money as major-unit decimal strings and lists field errors', async () => {
    const bad = await api.post<Json>('/v1/products', { name: '', price: '29.999', currency: 'USD' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: Json) => e.field).sort()).toEqual(['name', 'price']);

    const ok = await api.post<Json>('/v1/products', { name: 'Pro', price: '29', currency: 'USD' });
    expect(ok.body.price).toBe('29.00');
  });

  it('paginates with items + pagination, clamps limit and rejects bad cursors', async () => {
    for (let i = 0; i < 25; i += 1) await api.post('/v1/customers', { email: `c${i}@example.com` });
    const first = await api.get<Json>('/v1/customers');
    expect(first.body.items).toHaveLength(20);
    expect(first.body.pagination).toMatchObject({ has_more: true, limit: 20, offset: 0, returned: 20, total: 25, prev_cursor: null });
    const second = await api.get<Json>(`/v1/customers?cursor=${first.body.pagination.next_cursor}&offset=3`);
    expect(second.body.pagination).toMatchObject({ offset: 20, returned: 5, has_more: false, next_cursor: null });
    expect((await api.get<Json>('/v1/customers?limit=500')).body.pagination.limit).toBe(100);
    const badCursor = await api.get<Json>('/v1/customers?cursor=not-a-cursor');
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error_code).toBe('BAD_REQUEST');
  });

  it('caches 2xx responses per Idempotency-Key and rejects a different body', async () => {
    const first = await api.post<Json>('/v1/customers', { email: 'idem@example.com' }, { idempotencyKey: 'key-1' });
    const again = await api.post<Json>('/v1/customers', { email: 'idem@example.com' }, { idempotencyKey: 'key-1' });
    expect(again.body.id).toBe(first.body.id);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    const conflict = await api.post<Json>('/v1/customers', { email: 'other@example.com' }, { idempotencyKey: 'key-1' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error_code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('returns IDEMPOTENCY_IN_PROGRESS while the first request runs', async () => {
    const slow = api.post<Json>('/v1/customers', { email: 'race@example.com' }, { idempotencyKey: 'race', headers: { 'X-Mockrail-Latency': '300ms' } });
    await new Promise((r) => setTimeout(r, 50));
    const racing = await api.post<Json>('/v1/customers', { email: 'race@example.com' }, { idempotencyKey: 'race' });
    expect(racing.status).toBe(409);
    expect(racing.body.error_code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect((await slow).status).toBe(201);
  });

  it('forces a 429 with Retry-After on request', async () => {
    const res = await api.get<Json>('/v1/customers', { scenario: 'rate_limited' });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('x-ratelimit-limit')).toBe('100');
  });
});

describe('checkout and webhooks', () => {
  it('completes a checkout and delivers signed checkout.completed and collection.succeeded', async () => {
    const { checkoutId } = await recurringCheckout();
    await sb.control.payCheckout(checkoutId, { card_number: '4242424242424242' });
    await sb.advance('1s');

    const completed = await hooks.waitFor('checkout.completed');
    expect(completed.body.data).toMatchObject({ checkout_id: checkoutId, customer: { email: 'ada@example.com' }, charge: { status: 'succeeded', amount: '29.00' } });
    expect(typeof (completed.body.data as Json).customer.customer_id).toBe('string');
    const collection = await hooks.waitFor('collection.succeeded');
    expect((collection.body.data as Json).status).toBe('SUCCEEDED');
    expect(collection.body).toMatchObject({ organization_id: 'org_sandbox' });
    expect(collection.body.id).toMatch(/^evt_/);

    for (const webhook of [completed, collection]) {
      expect(verifyBachsSignature({ rawBody: webhook.rawBody, headers: webhook.headers, secret: hooks.secret })).toBe(true);
      expect(verifyBachsSignature({ rawBody: webhook.rawBody, headers: webhook.headers, secret: 'wrong' })).toBe(false);
    }
    expect(completed.headers['x-bachs-signature-v2']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);

    const subs = await api.get<Json>('/v1/subscriptions');
    expect(subs.body.items[0]).toMatchObject({ status: 'active', amount: '29.00' });
  });

  it('declines test card 4000000000000002', async () => {
    const charge = await api.post<Json>('/v1/charges', { amount: '10.00', currency: 'NGN', card: { number: '4000000000000002' } });
    expect(charge.body.status).toBe('open');
    await sb.advance('1s');
    const payment = await api.get<Json>(`/v1/payments/${charge.body.id}`);
    expect(payment.body).toMatchObject({ status: 'failed', substatus: 'declined' });
  });

  it('runs dunning on the virtual clock: retries at +1/+3/+5 days, then cancels', async () => {
    const { checkoutId } = await recurringCheckout();
    await sb.control.payCheckout(checkoutId);
    await sb.advance('1s');
    await sb.control.addScenario({ match: { operation: 'subscription.renew' }, outcome: 'fail:insufficient_funds', uses: 'unlimited' });

    await sb.advance('31d');
    const failed = await hooks.waitFor('invoice.payment_failed');
    expect((failed.body.data as Json).charge).not.toBeNull();
    await sb.advance('10d');

    const sub = (await api.get<Json>('/v1/subscriptions')).body.items[0];
    expect(sub).toMatchObject({ status: 'canceled', cancellation_reason: 'payment_failed' });
    await hooks.waitFor('subscription.canceled');
    expect(hooks.ofType('invoice.payment_failed')).toHaveLength(4);
    // active -> past_due has no documented event, so no subscription.updated was sent for it.
    expect(hooks.ofType('subscription.updated').filter((w) => (w.body.data as Json).status === 'past_due')).toHaveLength(0);
  });

  it('expires an unpaid checkout and sends checkout.expired', async () => {
    const res = await api.post<Json>('/v1/checkout-sessions', { amount: '50.00', currency: 'NGN', expires_in_minutes: 5 });
    expect(res.body.status).toBe('open');
    await sb.advance('6m');
    const expired = await hooks.waitFor('checkout.expired');
    expect((expired.body.data as Json).id).toBe(res.body.id);
    const badExpiry = await api.post<Json>('/v1/checkout-sessions', { amount: '1.00', currency: 'NGN', expires_in_minutes: 1441 });
    expect(badExpiry.status).toBe(400);
  });

  it('retries failed deliveries up to 5 attempts at +1, +5, +15, +60 minutes', async () => {
    hooks.respondWith(500);
    await api.post('/v1/charges', { amount: '10.00', currency: 'NGN' });
    await sb.advance('1s');
    await sb.advance('2h');
    const attempts = hooks.ofType('collection.succeeded');
    expect(attempts).toHaveLength(5);
    expect(new Set(attempts.map((a) => a.body.id)).size).toBe(1);
    const deliveries = (await sb.control.deliveries({ endpoint_id: hooks.endpointId })).items.filter((d) => d.status === 'failed');
    expect(deliveries.map((d) => d.attempt).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('sends duplicates when chaos is on', async () => {
    await sb.control.setChaos({ duplicate_rate: 1 });
    try {
      await api.post('/v1/customers', { email: 'x@y.z' });
      await api.post('/v1/charges', { amount: '10.00', currency: 'NGN' });
      await sb.advance('1s');
      await sb.control.runDue();
      const received = hooks.ofType('collection.succeeded');
      expect(received).toHaveLength(2);
      expect(received[0]?.body.id).toBe(received[1]?.body.id);
    } finally {
      await sb.control.setChaos({ duplicate_rate: 0 });
    }
  });
});

describe('virtual accounts', () => {
  it('returns the same 90-prefixed number and fires collection.succeeded on a simulated deposit', async () => {
    const first = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
    const again = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
    expect(first.body.account_number).toBe(again.body.account_number);
    expect(first.body.account_number).toMatch(/^90\d{8}$/);
    expect(first.body.bank_name).toBe('Sandbox Test Bank');

    await sb.control.deposit({ account_number: first.body.account_number, amount: '15000.00', sender_name: 'Chidi Okafor' });
    const event = await hooks.waitFor('collection.succeeded');
    expect(event.body.data).toMatchObject({ checkout_id: null, payment_type: 'bank_transfer', amount: '15000.00', sender: { name: 'Chidi Okafor' } });

    const balances = await api.get<Json>('/v1/balances');
    expect(balances.body.items).toEqual([{ currency: 'NGN', available_balance: '15000.00', pending_balance: '0.00' }]);
    const deposits = await api.get<Json>('/v1/payments?payment_type=ngn_bank_transfer');
    expect(deposits.body.items).toHaveLength(1);
  });

  it('holds deposits over NGN 5,000,000 but still fires the event', async () => {
    const va = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
    const result = await sb.control.deposit({ account_number: va.body.account_number, amount: '6000000.00' });
    expect(result.held).toBe(true);
    await hooks.waitFor('collection.succeeded');
    const balances = await api.get<Json>('/v1/balances');
    expect(balances.body.items[0]).toMatchObject({ available_balance: '0.00', pending_balance: '6000000.00' });
  });
});

describe('payouts and refunds', () => {
  async function fund(amount = '100000.00'): Promise<void> {
    const va = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
    await sb.control.deposit({ account_number: va.body.account_number, amount });
  }

  it('fails a payout to the documented failing bank trigger and emits payout.failed', async () => {
    await fund();
    const dest = await api.post<Json>('/v1/payouts/destinations', { type: 'bank', currency: 'NGN', bank_code: '998', account_number: '0001112224', account_name: 'Anyone' });
    const payout = await api.post<Json>('/v1/payouts', { destination_id: dest.body.id, amount: '5000.00' });
    expect(payout.body.status).toBe('pending');
    await sb.advance('1m');
    expect((await api.get<Json>(`/v1/payouts/${payout.body.id}`)).body.status).toBe('failed');
    await hooks.waitFor('payout.failed');
  });

  it('completes via quote, and rejects quotes older than 30 seconds', async () => {
    await fund();
    const dest = await api.post<Json>('/v1/payouts/destinations', { type: 'bank', currency: 'NGN', bank_code: '999', account_number: '0001112223' });
    const quote = await api.post<Json>('/v1/payouts/quotes', { destination_id: dest.body.id, amount: '1000.00' });
    const payout = await api.post<Json>('/v1/payouts', { destination_id: dest.body.id, quote_id: quote.body.id });
    expect(payout.status).toBe(201);
    await sb.advance('1m');
    await hooks.waitFor('payout.paid');

    const stale = await api.post<Json>('/v1/payouts/quotes', { destination_id: dest.body.id, amount: '1000.00' });
    await sb.advance('31s');
    const rejected = await api.post<Json>('/v1/payouts', { destination_id: dest.body.id, quote_id: stale.body.id });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error_code).toBe('QUOTE_EXPIRED');
  });

  it('requires recipient details on international payouts', async () => {
    const dest = await api.post<Json>('/v1/payouts/destinations', { type: 'bank', currency: 'USD', country: 'US', bank_code: '021', account_number: '123456789' });
    const res = await api.post<Json>('/v1/payouts', { destination_id: dest.body.id, amount: '10.00' });
    expect(res.body.error_code).toBe('PAYOUT_RECIPIENT_INCOMPLETE');
  });

  it('honours simulated_outcome on refunds', async () => {
    const charge = await api.post<Json>('/v1/charges', { amount: '100.00', currency: 'NGN' });
    await sb.advance('1s');
    const refund = await api.post<Json>('/v1/refunds', { payment_id: charge.body.id, amount: '40.00', simulated_outcome: 'failed' });
    expect(refund.body.status).toBe('processing');
    await sb.advance('10s');
    await hooks.waitFor('refund.failed');
    const ok = await api.post<Json>('/v1/refunds', { payment_id: charge.body.id, simulated_outcome: 'success' });
    expect(ok.body.amount).toBe('100.00');
    await sb.advance('10s');
    await hooks.waitFor('refund.paid');
    expect((await api.get<Json>(`/v1/payments/${charge.body.id}`)).body.status).toBe('refunded');
  });
});

describe('connect', () => {
  it('over-grants capabilities in sandbox and enforces destination-charge rules', async () => {
    const account = await api.post<Json>('/v1/accounts', { email: 'seller@example.com', capabilities: ['card_payments'] });
    expect(account.body.capabilities).toEqual({ card_payments: 'active', conversions: 'active' });

    const both = await api.post<Json>('/v1/charges', {
      amount: '100.00',
      currency: 'NGN',
      platform_fee: '10.00',
      transfer_data: { destination: account.body.id, amount: '90.00' },
    });
    expect(both.status).toBe(400);

    await api.post('/v1/charges', { amount: '100.00', currency: 'NGN', platform_fee: '10.00', transfer_data: { destination: account.body.id } });
    await sb.advance('1s');
    const platform = await api.get<Json>('/v1/balances');
    const seller = await api.get<Json>('/v1/balances', { account: account.body.id });
    expect(platform.body.items[0].available_balance).toBe('10.00');
    expect(seller.body.items[0].available_balance).toBe('90.00');
    const transfer = await hooks.waitFor('transfer.created');
    expect(transfer.body.account).toBe(account.body.id);
  });
});
