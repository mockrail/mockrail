import { describe, expect, it } from 'vitest';
import { DAY, money, parseDuration, PLATFORM_OWNER, Sandbox, SqliteStore, addInterval } from '../src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T0 = new Date('2026-11-01T09:00:00.000Z');

function sandbox(): Sandbox {
  return new Sandbox({ frozenAt: T0, seed: 42 });
}

describe('parseDuration', () => {
  it('parses human durations', () => {
    expect(parseDuration('30d')).toBe(30 * DAY);
    expect(parseDuration('+30 days')).toBe(30 * DAY);
    expect(parseDuration('1h30m')).toBe(90 * 60_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('2500')).toBe(2500);
    expect(() => parseDuration('soon')).toThrow();
  });
});

describe('addInterval', () => {
  it('clamps month ends', () => {
    expect(addInterval(new Date('2026-01-31T00:00:00Z'), 'month', 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addInterval(new Date('2026-01-15T00:00:00Z'), 'year', 1).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});

describe('virtual clock and scheduler', () => {
  it('runs due jobs in order and stamps each at its run time', async () => {
    const sb = sandbox();
    const seen: string[] = [];
    sb.scheduler.register<{ name: string }>('test.job', ({ name }) => {
      seen.push(`${name}@${sb.clock.now().toISOString()}`);
    });
    sb.scheduler.schedule('test.job', new Date(T0.getTime() + 2 * DAY), { name: 'b' });
    sb.scheduler.schedule('test.job', new Date(T0.getTime() + DAY), { name: 'a' });
    sb.scheduler.schedule('test.job', new Date(T0.getTime() + 10 * DAY), { name: 'later' });
    const results = await sb.clock.advanceBy({ milliseconds: 3 * DAY });
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(seen).toEqual(['a@2026-11-02T09:00:00.000Z', 'b@2026-11-03T09:00:00.000Z']);
    expect(sb.clock.now().toISOString()).toBe('2026-11-04T09:00:00.000Z');
    expect(sb.scheduler.pending()).toHaveLength(1);
  });
});

describe('ledger', () => {
  it('rejects unbalanced transactions and derives balances', () => {
    const sb = sandbox();
    expect(() =>
      sb.ledger.post({ description: 'bad', lines: [{ account: 'a', direction: 'debit', amount: money(100n, 'NGN') }] }),
    ).toThrow(/Unbalanced/);
    sb.ledger.move('external:card_network', 'owner:platform:available', money(2900n, 'NGN'), 'test');
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'available', 'NGN')).toBe(2900n);
    expect(sb.ledger.trialBalance().get('NGN')).toBe(0n);
  });
});

describe('charges', () => {
  it('finalizes a second after payment and credits the balance', async () => {
    const sb = sandbox();
    const charge = sb.charges.create({
      ownerId: PLATFORM_OWNER,
      amount: money(500_00n, 'NGN'),
      paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' },
    });
    expect(charge.status).toBe('pending');
    await sb.clock.advanceBy({ milliseconds: 1_000 });
    expect(sb.charges.get(PLATFORM_OWNER, charge.id).status).toBe('succeeded');
    expect(sb.ledger.balancesFor(PLATFORM_OWNER)).toEqual([{ currency: 'NGN', available: 500_00n, pending: 0n, reserved: 0n }]);
  });

  it('splits a destination charge between platform and connected account', async () => {
    const sb = sandbox();
    const account = sb.accounts.create({ capabilities: { card_payments: 'active' } });
    sb.charges.create({
      ownerId: PLATFORM_OWNER,
      amount: money(10_000n, 'NGN'),
      paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' },
      platformFee: money(1_000n, 'NGN'),
      transferDestination: account.id,
    });
    await sb.clock.advanceBy({ milliseconds: 1_000 });
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'available', 'NGN')).toBe(1_000n);
    expect(sb.ledger.bucketBalance(account.id, 'available', 'NGN')).toBe(9_000n);
    expect(sb.transfers.list()).toHaveLength(1);
    expect(sb.transfers.listPlatformFees()).toHaveLength(1);
  });

  it('keeps funds pending in live fidelity until settlement', async () => {
    const sb = sandbox();
    sb.setFidelity('live');
    sb.charges.create({ ownerId: PLATFORM_OWNER, amount: money(100n, 'USD'), paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' } });
    await sb.clock.advanceBy({ milliseconds: 1_000 });
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'pending', 'USD')).toBe(100n);
    await sb.clock.advanceBy({ milliseconds: DAY });
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'available', 'USD')).toBe(100n);
  });
});

describe('subscription dunning', () => {
  it('renews, fails, retries at +1/+3/+5 days, then cancels', async () => {
    const sb = sandbox();
    const product = sb.products.create({
      ownerId: PLATFORM_OWNER,
      name: 'Pro',
      price: money(29_00n, 'USD'),
      recurring: { interval: 'month', intervalCount: 1, trialDays: 0 },
    });
    const session = sb.checkout.create({ ownerId: PLATFORM_OWNER, productId: product.id, customerEmail: 'ada@example.com', expiresInMs: 60 * 60_000 });
    sb.checkout.pay(session.id, { paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' } });
    await sb.clock.advanceBy({ milliseconds: 1_000 });

    const completed = sb.checkout.get(PLATFORM_OWNER, session.id);
    expect(completed.status).toBe('completed');
    const subId = completed.subscriptionId as string;
    expect(sb.subscriptions.get(PLATFORM_OWNER, subId).status).toBe('active');

    sb.scenarios.addRule({ match: { operation: 'subscription.renew' }, outcome: { kind: 'fail', reason: 'insufficient_funds' }, remainingUses: 'unlimited' });

    await sb.clock.advanceBy({ milliseconds: 31 * DAY });
    expect(sb.subscriptions.get(PLATFORM_OWNER, subId).status).toBe('past_due');

    await sb.clock.advanceBy({ milliseconds: 10 * DAY });
    const canceled = sb.subscriptions.get(PLATFORM_OWNER, subId);
    expect(canceled.status).toBe('canceled');
    expect(canceled.cancellationReason).toBe('payment_failed');

    const failures = sb.events.list({ type: 'invoice.payment_failed' });
    expect(failures).toHaveLength(4);
    const times = failures.map((e) => Date.parse(e.occurredAt));
    expect([times[1]! - times[0]!, times[2]! - times[1]!, times[3]! - times[2]!]).toEqual([DAY, 3 * DAY, 5 * DAY]);
  });

  it('starts trialing and activates when the trial ends', async () => {
    const sb = sandbox();
    const product = sb.products.create({
      ownerId: PLATFORM_OWNER,
      name: 'Trial',
      price: money(10_00n, 'USD'),
      recurring: { interval: 'month', intervalCount: 1, trialDays: 14 },
    });
    const session = sb.checkout.create({ ownerId: PLATFORM_OWNER, productId: product.id, customerEmail: 'a@b.co', expiresInMs: 60_000 });
    expect(session.amount.amountMinor).toBe(0n);
    const { checkout } = sb.checkout.pay(session.id, { paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' } });
    const subId = checkout.subscriptionId as string;
    expect(sb.subscriptions.get(PLATFORM_OWNER, subId).status).toBe('trialing');
    await sb.subscriptions.endTrial(subId);
    expect(sb.subscriptions.get(PLATFORM_OWNER, subId).status).toBe('active');
    expect(sb.events.list({ type: 'invoice.paid' })).toHaveLength(1);
  });
});

describe('payouts and refunds', () => {
  it('reserves funds, then completes or fails a payout', async () => {
    const sb = sandbox();
    sb.ledger.move('external:card_network', 'owner:platform:available', money(100_000n, 'NGN'), 'seed');
    const dest = sb.payouts.createDestination({ ownerId: PLATFORM_OWNER, type: 'bank', currency: 'NGN', bankCode: '999', accountNumber: '0001112223' });
    const payout = sb.payouts.create({ ownerId: PLATFORM_OWNER, destinationId: dest.id, amount: money(40_000n, 'NGN'), outcomeOverride: { kind: 'fail', reason: 'bank_rejected' } });
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'reserved', 'NGN')).toBe(40_000n);
    await sb.clock.advanceBy({ milliseconds: 60_000 });
    expect(sb.payouts.get(PLATFORM_OWNER, payout.id).status).toBe('failed');
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'available', 'NGN')).toBe(100_000n);
  });

  it('rejects expired quotes', async () => {
    const sb = sandbox();
    sb.ledger.move('external:card_network', 'owner:platform:available', money(100_000n, 'NGN'), 'seed');
    const dest = sb.payouts.createDestination({ ownerId: PLATFORM_OWNER, type: 'bank', currency: 'NGN', bankCode: '999', accountNumber: '0001112223' });
    const quote = sb.payouts.createQuote({ ownerId: PLATFORM_OWNER, amount: money(1_000n, 'NGN'), ttlMs: 30_000 });
    await sb.clock.advanceBy({ milliseconds: 31_000 });
    expect(() => sb.payouts.create({ ownerId: PLATFORM_OWNER, destinationId: dest.id, quoteId: quote.id })).toThrow(/expired/);
  });

  it('allows repeated partial refunds up to the remainder', async () => {
    const sb = sandbox();
    const charge = sb.charges.create({ ownerId: PLATFORM_OWNER, amount: money(1_000n, 'NGN'), paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' } });
    await sb.clock.advanceBy({ milliseconds: 1_000 });
    sb.refunds.create({ ownerId: PLATFORM_OWNER, chargeId: charge.id, amount: money(600n, 'NGN'), allowDepositRefunds: true });
    sb.refunds.create({ ownerId: PLATFORM_OWNER, chargeId: charge.id, amount: money(400n, 'NGN'), allowDepositRefunds: true });
    expect(() => sb.refunds.create({ ownerId: PLATFORM_OWNER, chargeId: charge.id, amount: money(1n, 'NGN'), allowDepositRefunds: true })).toThrow();
  });
});

describe('virtual account deposits', () => {
  it('holds deposits above the limit and releases them without an event', () => {
    const sb = sandbox();
    const va = sb.virtualAccounts.create({ ownerId: PLATFORM_OWNER, currency: 'NGN', bankName: 'Test Bank', numberPrefix: '90', numberLength: 10, perDepositLimitMinor: 1_000n, dailyLimitMinor: 1_000n });
    expect(sb.virtualAccounts.create({ ownerId: PLATFORM_OWNER, currency: 'NGN', bankName: 'Test Bank', numberPrefix: '90', numberLength: 10 }).accountNumber).toBe(va.accountNumber);
    const held = sb.virtualAccounts.simulateDeposit({ accountNumber: va.accountNumber, amount: money(5_000n, 'NGN') });
    expect(held.settlement).toBe('held');
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'pending', 'NGN')).toBe(5_000n);
    sb.charges.releaseHeld(held.id);
    expect(sb.ledger.bucketBalance(PLATFORM_OWNER, 'available', 'NGN')).toBe(5_000n);
  });
});

describe('stores', () => {
  it('persists state in SQLite across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mockrail-'));
    try {
      const path = join(dir, 'state.db');
      const first = new Sandbox({ store: new SqliteStore(path), frozenAt: T0 });
      const customer = first.customers.create({ ownerId: PLATFORM_OWNER, email: 'persist@example.com' });
      first.ledger.move('external:card_network', 'owner:platform:available', money(123n, 'NGN'), 'seed');
      first.close();
      const second = new Sandbox({ store: new SqliteStore(path) });
      expect(second.customers.get(PLATFORM_OWNER, customer.id).email).toBe('persist@example.com');
      expect(second.ledger.bucketBalance(PLATFORM_OWNER, 'available', 'NGN')).toBe(123n);
      expect(second.clock.now().toISOString()).toBe(T0.toISOString());
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('snapshots and restores', () => {
    const sb = sandbox();
    const snap = sb.snapshot();
    sb.customers.create({ ownerId: PLATFORM_OWNER, email: 'x@y.z' });
    sb.restore(snap);
    expect(sb.customers.list(PLATFORM_OWNER)).toHaveLength(0);
  });
});
