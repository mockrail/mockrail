import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { money, platformOwner, Sandbox, SandboxError, type DomainEvent } from '@mockrail/core';
import {
  BACHS_EVENT_TYPES,
  BACHS_ID_FORMATS,
  bachsDeliveryPolicy,
  bachsWebhookSigner,
  createBachsAdapter,
  formatAmount,
  futureOutcomeForCard,
  outcomeForCard,
  outcomeForDestination,
  paginate,
  parseAmount,
  renderBachsError,
  verifyBachsSignature,
} from '../src/index.js';

const docs = JSON.parse(readFileSync(new URL('./fixtures/documented.json', import.meta.url), 'utf8'));
const adapter = createBachsAdapter();
const PLATFORM = platformOwner('bachs');

describe('Bachs contract: endpoints', () => {
  it('implements every documented endpoint', () => {
    const implemented = new Set(adapter.routes.map((r) => `${r.method} ${r.path}`));
    expect((docs.endpoints.routes as string[]).filter((r) => !implemented.has(r))).toEqual([]);
  });
});

describe('Bachs contract: errors', () => {
  it('always has detail and error_code; errors[] entries are {field, message, type}', () => {
    const plain = renderBachsError(new SandboxError('not_found', 'Nope')).body as Record<string, unknown>;
    expect(Object.keys(plain)).toEqual(docs.errors.requiredFields);
    const withFields = renderBachsError(new SandboxError('validation_failed', 'Bad', { fieldErrors: [{ field: 'amount', message: 'Required' }] })).body as { errors: object[] };
    expect(Object.keys(withFields.errors[0] as object).sort()).toEqual([...docs.errors.fieldErrorFields].sort());
  });

  it.each(Object.entries(docs.errors.codes as Record<string, { status: number; error_code: string }>))('maps core %s', (code, expected) => {
    const res = renderBachsError(new SandboxError(code as never, 'x'));
    expect({ status: res.status, error_code: (res.body as { error_code: string }).error_code }).toEqual(expected);
  });

  it.each(Object.entries(docs.errors.reasons as Record<string, { status: number; error_code: string }>))('maps reason %s', (reason, expected) => {
    const res = renderBachsError(new SandboxError('validation_failed', 'x', { details: { reason } }));
    expect({ status: res.status, error_code: (res.body as { error_code: string }).error_code }).toEqual(expected);
  });
});

describe('Bachs contract: pagination', () => {
  const items = Array.from({ length: 150 }, (_, i) => i);

  it('uses the documented list shape, default and clamp', () => {
    const page = paginate(items, {});
    expect(Object.keys(page).sort()).toEqual([...docs.pagination.listFields].sort());
    expect(Object.keys(page.pagination).sort()).toEqual([...docs.pagination.paginationFields].sort());
    expect(page.pagination.limit).toBe(docs.pagination.defaultLimit);
    expect(page.pagination.next_cursor).toBe(docs.pagination.cursorExample);
    expect(paginate(items, { limit: '1000' }).pagination.limit).toBe(docs.pagination.maxLimit);
  });

  it('rejects a malformed cursor with the documented message, and cursor beats offset', () => {
    expect(() => paginate(items, { cursor: 'abc' })).toThrow(docs.pagination.badCursorDetail);
    expect(paginate(items, { limit: '10', cursor: 'cur_10', offset: '40' }).items[0]).toBe(10);
  });
});

describe('Bachs contract: money', () => {
  it.each(docs.money.examples as { minor: number; currency: 'USD' | 'NGN'; wire: string }[])('formats $minor $currency as $wire', ({ minor, currency, wire }) => {
    expect(formatAmount(money(BigInt(minor), currency))).toBe(wire);
    expect(parseAmount(wire, currency)).toBe(BigInt(minor));
  });

  it('renders zero-decimal currencies with two decimals', () => {
    expect(formatAmount(money(5000n, 'UGX'))).toBe('5000.00');
    expect(parseAmount('5000.00', 'UGX')).toBe(5000n);
    expect(parseAmount('5000.50', 'UGX')).toBeNull();
  });
});

describe('Bachs contract: webhooks', () => {
  const secret = 'whsec_test';
  const rawBody = JSON.stringify({ id: 'evt_1', type: 'collection.succeeded' });
  const timestamp = new Date('2026-11-21T10:00:00Z');

  it('signs HMAC-SHA256 hex of "{timestamp}.{raw_body}" with timestamp in seconds', () => {
    const headers = bachsWebhookSigner.sign({ rawBody, timestamp, secrets: [secret] });
    const ts = String(Math.floor(timestamp.getTime() / 1000));
    const expected = createHmac('sha256', secret).update(docs.webhooks.signedPayload.replace('{timestamp}', ts).replace('{raw_body}', rawBody)).digest('hex');
    expect(Object.keys(headers).sort()).toEqual([...docs.webhooks.headers].sort());
    expect(headers['X-Bachs-Signature']).toBe(expected);
    expect(headers['X-Bachs-Signature-V2']).toBe(`t=${ts},v1=${expected}`);
  });

  it('sends one v1 per valid secret during rotation, and receivers accept either', () => {
    const headers = bachsWebhookSigner.sign({ rawBody, timestamp, secrets: ['whsec_new', 'whsec_old'] });
    expect(headers['X-Bachs-Signature-V2']?.match(/v1=/g)).toHaveLength(2);
    for (const s of ['whsec_new', 'whsec_old']) expect(verifyBachsSignature({ rawBody, headers, secret: s, now: timestamp })).toBe(true);
    expect(verifyBachsSignature({ rawBody: `${rawBody} `, headers, secret: 'whsec_new', now: timestamp })).toBe(false);
  });

  it('follows the documented delivery policy', () => {
    for (const status of docs.webhooks.retryableStatuses) expect(bachsDeliveryPolicy.isRetryable({ status })).toBe(true);
    for (const status of docs.webhooks.nonRetryableStatuses) expect(bachsDeliveryPolicy.isRetryable({ status })).toBe(false);
    expect(bachsDeliveryPolicy.isRetryable({ error: 'timeout' })).toBe(true);
    expect(bachsDeliveryPolicy.maxAttempts).toBe(docs.webhooks.maxAttempts);
    expect(bachsDeliveryPolicy.retryDelaysMs.map((ms) => ms / 60_000)).toEqual(docs.webhooks.retryDelaysMinutes);
    expect(bachsDeliveryPolicy.timeoutMs).toBe(docs.webhooks.timeoutSeconds * 1000);
  });

  it('emits exactly the documented event names (plus payment_method.saved from the saved-card guide)', () => {
    expect([...BACHS_EVENT_TYPES].filter((t) => t !== 'payment_method.saved').sort()).toEqual([...docs.events.emitted].sort());
  });

  it('builds the envelope; Connect events add account and use the account as organization_id', () => {
    const sb = new Sandbox({ seed: 1 });
    sb.ids.registerProvider('bachs', BACHS_ID_FORMATS);
    const account = sb.accounts.create({ platformOwnerId: PLATFORM, capabilities: {} });
    const transfer = sb.transfers.recordFromCharge({ fromOwner: PLATFORM, toOwner: sb.accounts.ownerOf(account), amount: money(7_000_00n, 'NGN'), chargeId: 'ch_1' });
    const event = sb.events.list({ type: 'transfer.created' })[0] as DomainEvent;
    const [mapped] = adapter.mapDomainEvent(event, sb);
    expect(Object.keys(mapped?.body ?? {}).sort()).toEqual([...docs.webhooks.envelopeFields, 'account'].sort());
    expect(mapped?.body).toMatchObject({ type: 'transfer.created', account: account.id, organization_id: account.id });
    expect(Object.keys((mapped?.body.data ?? {}) as object).sort()).toEqual([...docs.events.payloads['transfer.created']].sort());
    expect(mapped?.id.startsWith(docs.webhooks.eventIdPrefix)).toBe(true);
    expect(transfer.id.startsWith('tr_')).toBe(true);
  });

  it('uses the documented payout.paid and refund.created payload keys', () => {
    const sb = new Sandbox({ seed: 3, frozenAt: new Date('2026-11-21T10:00:00Z') });
    sb.ledger.move('external:bank_transfer', `owner:${PLATFORM}:available`, money(1_000_000n, 'NGN'), 'seed');
    const dest = sb.payouts.createDestination({ ownerId: PLATFORM, type: 'bank', currency: 'NGN', fundingCurrency: 'NGN', bankCode: '999', accountNumber: '0001112223', status: 'approved' });
    const payout = sb.payouts.create({ ownerId: PLATFORM, destinationId: dest.id, amount: money(5000n, 'NGN'), fee: money(50_00n, 'NGN') });
    const paid = adapter.mapDomainEvent({ id: 'd', type: 'payout.completed', occurredAt: '2026-11-21T10:00:00.000Z', ownerId: PLATFORM, sequence: 1, data: { payout: { ...payout, status: 'completed' }, destination: dest } }, sb)[0];
    expect(Object.keys((paid?.body.data ?? {}) as object)).toEqual(docs.events.payloads['payout.paid']);
    const charge = sb.charges.create({ ownerId: PLATFORM, amount: money(100n, 'NGN'), paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' } });
    const refund = adapter.mapDomainEvent({ id: 'r', type: 'refund.created', occurredAt: '2026-11-21T10:00:00.000Z', ownerId: PLATFORM, sequence: 2, data: { refund: { id: 'rfnd_1', chargeId: charge.id, amount: money(100n, 'NGN'), fee: money(0n, 'NGN'), feeBearer: 'merchant', status: 'pending', reason: null, reference: 'r1' } } }, sb)[0];
    expect(Object.keys((refund?.body.data ?? {}) as object)).toEqual(docs.events.payloads['refund.created']);
  });
});

describe('Bachs contract: sandbox triggers and ids', () => {
  it.each(Object.entries(docs.testCards.cards as Record<string, string>))('card %s -> %s', (number, reason) => {
    expect(outcomeForCard(number)).toEqual({ kind: 'fail', reason });
  });

  it('lets other cards succeed, and 0341 succeeds now but declines later', () => {
    expect(outcomeForCard(docs.testCards.succeeds)).toBeUndefined();
    expect(outcomeForCard(docs.testCards.savesThenDeclines)).toBeUndefined();
    expect(futureOutcomeForCard(docs.testCards.savesThenDeclines)).toEqual({ kind: 'fail', reason: 'declined' });
  });

  it('maps the documented withdrawal triggers', () => {
    const base = { id: 'pd', ownerId: PLATFORM, name: null, currency: 'NGN', fundingCurrency: 'NGN' as const, country: null, bankName: null, accountName: null, network: null, phone: null, mobileProvider: null, details: {}, status: 'approved' as const, statusReason: null, isDefault: false, reviewedAt: null, metadata: {}, createdAt: '', updatedAt: '' };
    const t = docs.payoutTriggers;
    expect(outcomeForDestination({ ...base, type: 'bank', bankCode: t.bankComplete.bank_code, accountNumber: t.bankComplete.account_number, walletAddress: null })).toEqual({ kind: 'succeed' });
    expect(outcomeForDestination({ ...base, type: 'bank', bankCode: t.bankFail.bank_code, accountNumber: t.bankFail.account_number, walletAddress: null })?.kind).toBe('fail');
    expect(outcomeForDestination({ ...base, type: 'crypto', bankCode: null, accountNumber: null, walletAddress: t.cryptoComplete })).toEqual({ kind: 'succeed' });
    expect(outcomeForDestination({ ...base, type: 'crypto', bankCode: null, accountNumber: null, walletAddress: t.cryptoFail })?.kind).toBe('fail');
    expect(outcomeForDestination({ ...base, type: 'mobile_money', bankCode: null, accountNumber: null, walletAddress: null })).toBeUndefined();
  });

  it('uses the documented ID prefixes', () => {
    const { source: _source, ...prefixes } = docs.idPrefixes as Record<string, string>;
    for (const [kind, prefix] of Object.entries(prefixes)) {
      const format = BACHS_ID_FORMATS[kind as keyof typeof BACHS_ID_FORMATS];
      expect(typeof format === 'string' ? format : format?.prefix).toBe(prefix);
    }
  });
});
