import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBachsAdapter, verifyBachsSignature } from '@mockrail/adapter-bachs';
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

async function recurringProduct(price = '29.00'): Promise<string> {
  const product = await api.post<Json>('/v1/products', { name: 'Pro plan', price: { currency: 'USD', amount: price }, billing_cycle: { interval: 'month', frequency: 1 } });
  expect(product.status).toBe(201);
  return product.body.id;
}

async function subscribe(card = '4242424242424242'): Promise<{ checkoutId: string }> {
  const productId = await recurringProduct();
  const checkout = await api.post<Json>('/v1/checkout-sessions', { product_cart: [{ product_id: productId }], customer: { email: 'ada@example.com', name: 'Ada' } });
  expect(checkout.status).toBe(201);
  await sb.control.payCheckout(checkout.body.checkout_id, { card_number: card });
  await sb.advance('1s');
  return { checkoutId: checkout.body.checkout_id };
}

async function fundNgn(amount = '1000000.00'): Promise<void> {
  const va = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
  await sb.control.deposit({ account_number: va.body.account_number, amount });
}

describe('wire conventions', () => {
  it('rejects bad keys with the flat error shape and a UUID request id', async () => {
    const res = await fetch(`${sb.url}/bachs/v1/customers`);
    expect(res.status).toBe(401);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toMatchObject({ error_code: 'UNAUTHORIZED', detail: expect.any(String) });
    expect((await fetch(`${sb.url}/bachs/v1/customers`, { headers: { authorization: 'Bearer sk_live_abc' } })).status).toBe(401);
  });

  it('lists field errors as {field, message, type} under VALIDATION_ERROR', async () => {
    const bad = await api.post<Json>('/v1/products', { name: '', price: { currency: 'USD', amount: '29.999' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error_code).toBe('VALIDATION_ERROR');
    expect(bad.body.errors.map((e: Json) => e.field).sort()).toEqual(['name', 'price.amount']);
    expect(bad.body.errors[0].type).toBe('value_error');
    const product = await api.post<Json>('/v1/products', { name: 'Pro', price: { currency: 'USD', amount: '29' } });
    expect(product.body).toMatchObject({ id: expect.stringMatching(/^prod_/), status: 'active', price: { amount: '29.00', price_type: 'fixed' } });
  });

  it('paginates with cur_<offset> cursors, per-endpoint defaults and clamping', async () => {
    for (let i = 0; i < 25; i += 1) await api.post('/v1/products', { name: `P${i}`, price: { currency: 'USD', amount: '1.00' } });
    const first = await api.get<Json>('/v1/products');
    expect(first.body.items).toHaveLength(20);
    expect(first.body.pagination).toMatchObject({ next_cursor: 'cur_20', prev_cursor: null, has_more: true, limit: 20, offset: 0, returned: 20, total: 25 });
    const second = await api.get<Json>('/v1/products?cursor=cur_20&offset=3');
    expect(second.body.pagination).toMatchObject({ offset: 20, returned: 5, has_more: false });
    expect((await api.get<Json>('/v1/products?limit=500')).body.pagination.limit).toBe(100);
    const bad = await api.get<Json>('/v1/products?cursor=abc');
    expect(bad.body).toMatchObject({ error_code: 'BAD_REQUEST', detail: "Invalid cursor format. Expected 'cur_<offset>'." });
  });

  it('caches 2xx per Idempotency-Key and rejects a different body', async () => {
    const first = await api.post<Json>('/v1/customers', { email: 'idem@example.com' }, { idempotencyKey: 'key-1' });
    expect(first.body.customer_id).toMatch(/^cust_/);
    const again = await api.post<Json>('/v1/customers', { email: 'idem@example.com' }, { idempotencyKey: 'key-1' });
    expect(again.body.customer_id).toBe(first.body.customer_id);
    const conflict = await api.post<Json>('/v1/customers', { email: 'other@example.com' }, { idempotencyKey: 'key-1' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error_code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('returns IDEMPOTENCY_IN_PROGRESS while the first request runs', async () => {
    const slow = api.post<Json>('/v1/customers', { email: 'race@example.com' }, { idempotencyKey: 'race', headers: { 'X-Mockrail-Latency': '300ms' } });
    await new Promise((r) => setTimeout(r, 50));
    const racing = await api.post<Json>('/v1/customers', { email: 'race@example.com' }, { idempotencyKey: 'race' });
    expect(racing.body.error_code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect((await slow).status).toBe(201);
  });

  it('returns the existing customer when the email is reused', async () => {
    const first = await api.post<Json>('/v1/customers', { email: 'Jane@Example.com', name: 'Jane' });
    const again = await api.post<Json>('/v1/customers', { email: 'jane@example.com', phone_number: '+2348012345678' });
    expect(again.body).toMatchObject({ customer_id: first.body.customer_id, name: 'Jane', phone_number: '+2348012345678' });
    await hooks.waitFor('customer.updated');
  });

  it('forces a 429 TOO_MANY_REQUESTS with Retry-After', async () => {
    const res = await api.get<Json>('/v1/customers', { scenario: 'rate_limited' });
    expect(res.status).toBe(429);
    expect(res.body.error_code).toBe('TOO_MANY_REQUESTS');
    expect(res.headers.get('retry-after')).toBe('1');
  });
});

describe('checkout and webhooks', () => {
  it('completes a subscription checkout with the documented events and signatures', async () => {
    const { checkoutId } = await subscribe();
    expect(checkoutId).toMatch(/^chk_/);

    const completed = await hooks.waitFor('checkout.completed');
    expect(completed.body.data).toMatchObject({
      checkout_id: checkoutId,
      status: 'completed',
      mode: 'subscription',
      payment_status: 'paid',
      customer: { customer_id: expect.stringMatching(/^cust_/), email: 'ada@example.com' },
      charge: { id: expect.stringMatching(/^ch_/), status: 'succeeded', amount: '29.00' },
      subscription: { subscription_id: expect.stringMatching(/^sub_/) },
    });
    expect(completed.body.organization_id).toBe('acct_SandboxPlatform01');
    expect(completed.body.created_at).toMatch(/\+00:00$/);
    const collection = await hooks.waitFor('collection.succeeded');
    expect(collection.body.data).toMatchObject({ status: 'SUCCEEDED', checkout_id: checkoutId, customer: { id: expect.stringMatching(/^cust_/) } });
    await hooks.waitFor('customer.subscription.created');
    await hooks.waitFor('invoice.paid');

    for (const webhook of [completed, collection]) {
      expect(verifyBachsSignature({ rawBody: webhook.rawBody, headers: webhook.headers, secret: hooks.secret })).toBe(true);
    }
    expect(hooks.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const session = await api.get<Json>(`/v1/checkout-sessions/${checkoutId}`);
    expect(session.body).toMatchObject({ status: 'completed', payment_status: 'succeeded', session_mode: 'CART', recurring: { interval: 'month', interval_count: 1 } });
    const subs = await api.get<Json>('/v1/subscriptions');
    expect(subs.body.items[0]).toMatchObject({ status: 'active', amount: '29.00', billing_cycle: { interval: 'month', frequency: 1 }, customer: { email: 'ada@example.com' } });
  });

  it('charges a saved card off-session, and 4000000000000341 declines later charges', async () => {
    for (const [card, expected] of [['4242424242424242', 'succeeded'], ['4000000000000341', 'failed']] as const) {
      const checkout = await api.post<Json>('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '5.00' }, customer: { email: `${card}@example.com` }, save_payment_method: true });
      await sb.control.payCheckout(checkout.body.checkout_id, { card_number: card });
      await sb.advance('1s');
      const customer = (await api.get<Json>(`/v1/checkout-sessions/${checkout.body.checkout_id}`)).body.customer.id;
      const charge = await api.post<Json>('/v1/charges', { customer, amount: '29.00', currency: 'USD' }, { idempotencyKey: `charge-${card}` });
      expect(charge.status).toBe(201);
      expect(charge.body).toMatchObject({ status: 'processing', payment_method: 'CARD', billing_reason: 'purchase' });
      await sb.advance('1s');
      expect((await api.get<Json>(`/v1/payments/${charge.body.payment_id}`)).body.status).toBe(expected);
    }
    const failed = await hooks.waitFor('collection.failed');
    expect(failed.body.data).toMatchObject({ status: 'FAILED', reason: 'Card declined' });
  });

  it('rejects a charge for a customer without a saved card', async () => {
    const customer = await api.post<Json>('/v1/customers', { email: 'nocard@example.com' });
    const res = await api.post<Json>('/v1/charges', { customer: customer.body.customer_id, amount: '1.00', currency: 'USD' });
    expect(res.body.error_code).toBe('NO_SAVED_PAYMENT_METHOD');
  });

  it('runs dunning on the virtual clock: retries at +1/+3/+5 days, then deletes', async () => {
    await subscribe();
    await sb.control.addScenario({ match: { operation: 'subscription.renew' }, outcome: 'fail:insufficient_funds', uses: 'unlimited' });
    await sb.advance('31d');
    await hooks.waitFor('invoice.created');
    const failed = await hooks.waitFor('invoice.payment_failed');
    expect(failed.body.data).toMatchObject({ status: 'open', attempt_count: 1, charge: { status: 'failed' }, subscription: { subscription_id: expect.any(String) } });
    expect((await api.get<Json>('/v1/subscriptions')).body.items[0].status).toBe('past_due');
    await sb.advance('10d');
    const sub = (await api.get<Json>('/v1/subscriptions')).body.items[0];
    expect(sub).toMatchObject({ status: 'canceled', next_billed_at: null });
    await hooks.waitFor('customer.subscription.deleted');
    expect(hooks.ofType('invoice.payment_failed')).toHaveLength(4);
  });

  it('expires an unpaid checkout and sends checkout.expired', async () => {
    const res = await api.post<Json>('/v1/checkout-sessions', { pricing: { currency: 'NGN', amount: '50.00' }, expires_in_minutes: 5 });
    await sb.advance('6m');
    const expired = await hooks.waitFor('checkout.expired');
    expect(expired.body.data).toMatchObject({ checkout_id: res.body.checkout_id, status: 'expired', payment_status: null, charge: null });
    expect((await api.post<Json>('/v1/checkout-sessions', { pricing: { currency: 'NGN', amount: '1.00' }, expires_in_minutes: 1441 })).status).toBe(400);
  });

  it('retries failed deliveries up to 5 attempts at +1, +5, +15, +60 minutes', async () => {
    hooks.respondWith(500);
    await fundNgn('100.00');
    await sb.advance('2h');
    const attempts = hooks.ofType('collection.succeeded');
    expect(attempts).toHaveLength(5);
    const detail = await api.get<Json>(`/v1/webhooks/events/${attempts[0]?.body.id}`);
    expect(detail.body.attempts.map((a: Json) => a.attempt_no)).toEqual([5, 4, 3, 2, 1]);
    expect(detail.body.attempts[0]).toMatchObject({ status: 'failed', http_status: 500, last_error: 'Endpoint returned HTTP 500' });
  });

  it('manages endpoints through the API and replays by charge id', async () => {
    const created = await api.post<Json>('/v1/webhooks/endpoints', { name: 'Prod', url: hooks.url, event_types: ['COLLECTION.SUCCEEDED'] });
    expect(created.body).toMatchObject({ endpoint_id: expect.stringMatching(/^whe_[0-9a-f]{32}$/), enabled: true, event_types: ['collection.succeeded'], event_source: 'account', signing_secret: expect.stringMatching(/^whsec_/) });
    const bad = await api.post<Json>('/v1/webhooks/endpoints', { name: 'x', url: 'http://example.com/hook', event_types: ['collection.succeeded'] });
    expect(bad.body.error_code).toBe('VALIDATION_ERROR');
    await fundNgn('100.00');
    await sb.control.runDue();
    const charge = (await api.get<Json>('/v1/payments')).body.items[0].id;
    const replay = await api.post<Json>('/v1/webhooks/replay', { charge_id: charge });
    expect(replay.body).toMatchObject({ event_type: 'collection.succeeded', attempt_id: expect.stringMatching(/^wha_/) });
    const del = await api.delete<Json>(`/v1/webhooks/endpoints/${created.body.endpoint_id}`);
    expect(del.body).toEqual({ status: 'deleted', endpoint_id: created.body.endpoint_id });
  });
});

describe('virtual accounts and balances', () => {
  it('returns the same 90-number and sends a deposit as collection.succeeded with fees', async () => {
    const first = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
    const again = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
    expect(first.status).toBe(200);
    expect(again.body.account_number).toBe(first.body.account_number);
    expect(first.body).toMatchObject({ id: expect.stringMatching(/^va_/), account_number: expect.stringMatching(/^90\d{8}$/), bank_name: 'Sandbox Test Bank', status: 'active' });
    expect((await api.post<Json>('/v1/virtual-accounts', { currency: 'USD' })).body.error_code).toBe('VIRTUAL_ACCOUNT_CURRENCY_NOT_SUPPORTED');
    expect((await api.get<Json>('/v1/virtual-accounts?currency=NGN')).body.id).toBe(first.body.id);

    await sb.control.deposit({ account_number: first.body.account_number, amount: '15000.00', sender_name: 'CHIDI OKAFOR' });
    const event = await hooks.waitFor('collection.succeeded');
    expect(event.body.data).toMatchObject({
      checkout_id: null,
      status: 'SUCCEEDED',
      amount: '15000.00',
      processing_fee: '150.00',
      settlement_amount: '14850.00',
      customer: { id: null },
      payment_method_details: { type: 'bank_transfer', bank_transfer: { sender_name: 'CHIDI OKAFOR', virtual_account: { id: first.body.id, type: 'permanent' } } },
    });
    const balances = await api.get<Json>('/v1/balances');
    expect(balances.body).toMatchObject({ account_id: 'acct_SandboxPlatform01', balances: [{ currency: 'NGN', available_balance: '14850.00', pending_balance: '0.00' }] });
    const deposits = await api.get<Json>('/v1/payments');
    expect(deposits.body.items[0].payment_method).toMatchObject({ type: 'ngn_bank_transfer' });
  });

  it('holds over-limit deposits outside both balances but still sends the event', async () => {
    const va = await api.post<Json>('/v1/virtual-accounts', { currency: 'NGN' });
    expect((await sb.control.deposit({ account_number: va.body.account_number, amount: '6000000.00' })).held).toBe(true);
    await hooks.waitFor('collection.succeeded');
    expect((await api.get<Json>('/v1/balances')).body.balances[0]).toMatchObject({ available_balance: '0.00', pending_balance: '0.00' });
  });
});

describe('payouts', () => {
  it('resolves NGN destinations, charges the NGN 50 fee and fails on the 998 trigger', async () => {
    await fundNgn();
    const dest = await api.post<Json>('/v1/payouts/destinations', { type: 'bank_account', currency: 'NGN', bank_code: '998', account_number: '0001112224', account_name: 'Ignored' });
    expect(dest.status).toBe(201);
    expect(dest.body).toMatchObject({ id: expect.stringMatching(/^pd_/), type: 'bank_account', status: 'approved', is_usable: true, account_name: 'SANDBOX ACCOUNT HOLDER' });
    const payout = await api.post<Json>('/v1/payouts', { destination: dest.body.id, amount: '5000.00', reference: 'payout-001' });
    expect(payout.status).toBe(200);
    expect(payout.body).toMatchObject({ id: expect.stringMatching(/^pay_/), status: 'pending', amount: '5000.00', fee: '50.00', total_debited: '5050.00', narration: 'Bachs Payout' });
    await sb.advance('1m');
    const failed = await hooks.waitFor('payout.failed');
    expect(failed.body.data).toMatchObject({ withdrawal_id: payout.body.id, status: 'failed', withdrawal_fee: '50.00' });
    const dup = await api.post<Json>('/v1/payouts', { destination: dest.body.id, amount: '1.00', reference: 'payout-001' });
    expect(dup.body.detail).toBe('Reference already exists for this organization');
    const listed = await api.get<Json>('/v1/payouts?reference=payout-001');
    expect(listed.body).toMatchObject({ total: 1 });
  });

  it('enforces amount XOR quote_id and rejects quotes older than 30 seconds', async () => {
    await fundNgn();
    const dest = await api.post<Json>('/v1/payouts/destinations', { type: 'bank_account', currency: 'NGN', bank_code: '999', account_number: '0001112223' });
    expect((await api.post<Json>('/v1/payouts', { destination: dest.body.id })).body.error_code).toBe('AMOUNT_REQUIRED');
    const quote = await api.post<Json>('/v1/payouts/quotes', { from_currency: 'NGN', to_currency: 'NGN', amount: '1000.00' });
    expect(quote.body).toMatchObject({ quote_id: expect.stringMatching(/^pqt_/), from_amount: '1000.00', to_amount: '950.00' });
    expect((await api.post<Json>('/v1/payouts', { destination: dest.body.id, quote_id: quote.body.quote_id, amount: '1.00' })).body.error_code).toBe('AMOUNT_NOT_ALLOWED_WITH_QUOTE');
    await sb.advance('31s');
    expect((await api.post<Json>('/v1/payouts', { destination: dest.body.id, quote_id: quote.body.quote_id })).body.error_code).toBe('QUOTE_EXPIRED');
  });

  it('quotes USD to NGN with the 1% fee taken before conversion', async () => {
    const quote = await api.post<Json>('/v1/payouts/quotes', { from_currency: 'USD', to_currency: 'NGN', amount: '100.00' });
    expect(quote.body).toMatchObject({ from_amount: '100.00', to_amount: '148500.00', exchange_rate: '1500.00' });
  });
});

describe('refunds', () => {
  it('allows one refund per charge, retrying after a failure', async () => {
    const checkout = await api.post<Json>('/v1/checkout-sessions', { pricing: { currency: 'NGN', amount: '100.00' } });
    await sb.control.payCheckout(checkout.body.checkout_id, { email: 'buyer@example.com' });
    await sb.advance('1s');
    const chargeId = (await api.get<Json>(`/v1/checkout-sessions/${checkout.body.checkout_id}`)).body.charge.payment_id;

    const failed = await api.post<Json>('/v1/refunds', { charge_id: chargeId, reference: 'r1', amount: '40.00', simulated_outcome: 'failed' });
    expect(failed.body).toMatchObject({ refund_id: expect.stringMatching(/^rfnd_/), status: 'processing', requested_amount: '40.00', refunded_amount: null, fee_bearer: 'org' });
    await sb.advance('10s');
    expect((await hooks.waitFor('refund.failed')).body.data).toMatchObject({ status: 'failed', fee_bearer: 'merchant' });

    const ok = await api.post<Json>('/v1/refunds', { charge_id: chargeId, reference: 'r2' });
    await sb.advance('10s');
    expect((await hooks.waitFor('refund.paid')).body.data).toMatchObject({ refund_id: ok.body.refund_id, status: 'paid', refunded_amount: '100.00' });
    expect((await api.get<Json>(`/v1/refunds/${ok.body.refund_id}`)).body.status).toBe('success');
    expect((await api.get<Json>(`/v1/payments/${chargeId}`)).body).toMatchObject({ status: 'refunded', is_refundable: false });

    const third = await api.post<Json>('/v1/refunds', { charge_id: chargeId, reference: 'r3', amount: '1.00' });
    expect(third.status).toBe(409);
    expect((await api.post<Json>('/v1/refunds', { charge_id: chargeId, reference: 'r2' })).body.detail).toBe('Refund reference already exists.');
    expect((await api.get<Json>('/v1/refunds')).body.total).toBe(2);
  });
});

describe('connect', () => {
  it('grants the configuration set in sandbox, splits destination charges and sends Connect events', async () => {
    const account = await api.post<Json>('/v1/accounts', { contact_email: 'seller@example.com', configuration: { merchant: {}, recipient: {} } });
    expect(account.status).toBe(201);
    expect(account.body.capabilities).toMatchObject({ payouts: { status: 'active' }, transfers: { status: 'active' }, conversions: { status: 'active' }, card_collection: { status: 'active' } });

    const both = await api.post<Json>('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '100.00' }, platform_fee: '10.00', transfer_data: { destination: account.body.id, amount: '90.00' } });
    expect(both.status).toBe(400);
    const neither = await api.post<Json>('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '100.00' }, transfer_data: { destination: account.body.id } });
    expect(neither.body.error_code).toBe('INVALID_PLATFORM_FEE');

    const checkout = await api.post<Json>('/v1/checkout-sessions', { pricing: { currency: 'USD', amount: '100.00' }, platform_fee: '10.00', transfer_data: { destination: account.body.id } });
    await sb.control.payCheckout(checkout.body.checkout_id, { email: 'buyer@example.com' });
    await sb.advance('1s');
    expect((await api.get<Json>('/v1/balances')).body.balances[0].available_balance).toBe('10.00');
    expect((await api.get<Json>('/v1/balances', { account: account.body.id })).body.balances[0].available_balance).toBe('90.00');
    const transfer = await hooks.waitFor('transfer.created');
    expect(transfer.body).toMatchObject({ account: account.body.id, organization_id: account.body.id, data: { kind: 'payout', destination: account.body.id } });
    const fees = await api.get<Json>('/v1/platform_fees');
    expect(fees.body.items[0]).toMatchObject({ id: expect.stringMatching(/^pf_/), amount: '10.00', collected_from: 'seller', earned_by: 'platform' });

    const forbidden = await api.get<Json>('/v1/balances', { account: 'acct_doesnotexist' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error_code).toBe('FORBIDDEN');
  });
});

describe('provider isolation', () => {
  it('keeps two providers’ data and webhooks apart', async () => {
    const second = { ...createBachsAdapter(), providerId: 'bachs2', displayName: 'Bachs (second account)' };
    const multi = await startSandbox({ providers: ['bachs', second] });
    try {
      const a = multi.api('bachs');
      const b = multi.api('bachs2');
      const hooksA = await multi.webhooks({ provider: 'bachs' });
      const hooksB = await multi.webhooks({ provider: 'bachs2' });
      await a.post('/v1/customers', { email: 'only-a@example.com' });
      await multi.control.runDue();
      expect((await a.get<Json>('/v1/customers')).body.items).toHaveLength(1);
      expect((await b.get<Json>('/v1/customers')).body.items).toHaveLength(0);
      await hooksA.waitFor('customer.created');
      expect(hooksB.received).toHaveLength(0);
    } finally {
      await multi.close();
    }
  });
});
