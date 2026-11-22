import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { money, PLATFORM_OWNER, Sandbox, SandboxError } from '@mockrail/core';
import {
  bachsDeliveryPolicy,
  bachsWebhookSigner,
  createBachsAdapter,
  formatAmount,
  outcomeForCard,
  outcomeForDestination,
  paginate,
  renderBachsError,
  verifyBachsSignature,
} from '../src/index.js';
import { chargeStatus, refundStatus, webhookChargeStatus } from '../src/statuses.js';

const docs = JSON.parse(readFileSync(new URL('./fixtures/documented.json', import.meta.url), 'utf8'));
const adapter = createBachsAdapter();

describe('Bachs contract: endpoints', () => {
  it('implements every documented v1 endpoint', () => {
    const implemented = new Set(adapter.routes.map((r) => `${r.method} ${r.path}`));
    const missing = (docs.endpoints.routes as string[]).filter((r) => !implemented.has(r));
    expect(missing).toEqual([]);
  });
});

describe('Bachs contract: errors', () => {
  it('renders the flat error object', () => {
    const res = renderBachsError(new SandboxError('validation_failed', 'Bad', { fieldErrors: [{ field: 'amount', message: 'Required' }] }));
    expect(Object.keys(res.body as object).sort()).toEqual([...docs.errors.fields].sort());
    expect(Object.keys((res.body as { errors: object[] }).errors[0] as object).sort()).toEqual([...docs.errors.fieldErrorFields].sort());
  });

  it.each(Object.entries(docs.errors.codes as Record<string, { status?: number; error_code?: string }>))('maps %s', (code, expected) => {
    const res = renderBachsError(new SandboxError(code as never, 'x'));
    if (expected.status) expect(res.status).toBe(expected.status);
    if (expected.error_code) expect((res.body as { error_code: string }).error_code).toBe(expected.error_code);
  });
});

describe('Bachs contract: pagination', () => {
  it('uses the documented list shape, default and clamp', () => {
    const items = Array.from({ length: 150 }, (_, i) => i);
    const page = paginate(items, {});
    expect(Object.keys(page).sort()).toEqual([...docs.pagination.listFields].sort());
    expect(Object.keys(page.pagination).sort()).toEqual([...docs.pagination.paginationFields].sort());
    expect(page.pagination.limit).toBe(docs.pagination.defaultLimit);
    expect(paginate(items, { limit: '1000' }).pagination.limit).toBe(docs.pagination.maxLimit);
    expect(() => paginate(items, { cursor: '%%%' })).toThrow(SandboxError);
  });

  it('lets cursor take precedence over offset', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const next = paginate(items, { limit: '10' }).pagination.next_cursor as string;
    expect(paginate(items, { limit: '10', cursor: next, offset: '40' }).items[0]).toBe(10);
  });
});

describe('Bachs contract: money', () => {
  it.each(docs.money.examples as { minor: number; currency: 'USD'; wire: string }[])('formats $minor as $wire', ({ minor, currency, wire }) => {
    expect(formatAmount(money(BigInt(minor), currency))).toBe(wire);
  });
});

describe('Bachs contract: webhook signing and delivery', () => {
  const secret = 'whsec_test';
  const rawBody = JSON.stringify({ id: 'evt_1', type: 'collection.succeeded' });
  const timestamp = new Date('2026-11-21T10:00:00Z');

  it('signs HMAC-SHA256 hex of "{timestamp}.{raw_body}"', () => {
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

  it('follows the documented retry policy', () => {
    for (const status of docs.webhooks.retryableStatuses) expect(bachsDeliveryPolicy.isRetryable({ status })).toBe(true);
    for (const status of docs.webhooks.nonRetryableStatuses) expect(bachsDeliveryPolicy.isRetryable({ status })).toBe(false);
    expect(bachsDeliveryPolicy.isRetryable({ error: 'timeout' })).toBe(true);
    expect(bachsDeliveryPolicy.isRetryable({ error: 'connection_error' })).toBe(true);
    expect(bachsDeliveryPolicy.maxAttempts).toBe(docs.webhooks.maxAttempts);
    expect(bachsDeliveryPolicy.retryDelaysMs.map((ms) => ms / 60_000)).toEqual(docs.webhooks.retryDelaysMinutes);
    expect(bachsDeliveryPolicy.timeoutMs).toBe(docs.webhooks.timeoutSeconds * 1000);
    expect(bachsDeliveryPolicy.isSuccess(204)).toBe(true);
    expect(bachsDeliveryPolicy.isSuccess(301)).toBe(false);
  });

  it('builds the documented envelope, adding account for Connect events', () => {
    const sb = new Sandbox({ seed: 1 });
    const account = sb.accounts.create({ capabilities: {} });
    const [platformEvent] = adapter.mapDomainEvent(
      { id: 'dev_1', type: 'payout.completed', occurredAt: '2026-11-21T10:00:00.000Z', ownerId: PLATFORM_OWNER, sequence: 1, data: { payout: fakePayout() } },
      sb,
    );
    expect(Object.keys(platformEvent?.body ?? {}).sort()).toEqual([...docs.webhooks.envelopeFields].sort());
    expect(platformEvent?.id.startsWith(docs.webhooks.eventIdPrefix)).toBe(true);
    const [connectEvent] = adapter.mapDomainEvent(
      { id: 'dev_2', type: 'payout.completed', occurredAt: '2026-11-21T10:00:00.000Z', ownerId: account.id, sequence: 2, data: { payout: fakePayout() } },
      sb,
    );
    expect(connectEvent?.body.account).toBe(account.id);
    expect(connectEvent?.type).toBe('payout.paid');
  });
});

describe('Bachs contract: sandbox triggers', () => {
  it.each(Object.entries(docs.testCards.cards as Record<string, string>))('card %s -> %s', (number, reason) => {
    expect(outcomeForCard(number)).toEqual({ kind: 'fail', reason });
  });

  it('lets any other card succeed', () => {
    expect(outcomeForCard(docs.testCards.succeeds)).toBeUndefined();
  });

  it('maps the documented withdrawal triggers', () => {
    const base = { id: 'dest', ownerId: PLATFORM_OWNER, currency: 'NGN' as const, country: null, bankName: null, accountName: null, network: null, phone: null, mobileProvider: null, recipient: null, metadata: {}, createdAt: '' };
    const t = docs.payoutTriggers;
    expect(outcomeForDestination({ ...base, type: 'bank', bankCode: t.bankComplete.bank_code, accountNumber: t.bankComplete.account_number, cryptoAddress: null })).toEqual({ kind: 'succeed' });
    expect(outcomeForDestination({ ...base, type: 'bank', bankCode: t.bankFail.bank_code, accountNumber: t.bankFail.account_number, cryptoAddress: null })?.kind).toBe('fail');
    expect(outcomeForDestination({ ...base, type: 'crypto', bankCode: null, accountNumber: null, cryptoAddress: t.cryptoComplete })).toEqual({ kind: 'succeed' });
    expect(outcomeForDestination({ ...base, type: 'crypto', bankCode: null, accountNumber: null, cryptoAddress: t.cryptoFail })?.kind).toBe('fail');
    expect(outcomeForDestination({ ...base, type: 'mobile_money', bankCode: null, accountNumber: null, cryptoAddress: null })).toBeUndefined();
  });
});

describe('Bachs contract: status vocabularies', () => {
  const sb = new Sandbox({ seed: 2 });
  const charge = sb.charges.create({ ownerId: PLATFORM_OWNER, amount: money(100n, 'NGN'), paymentMethod: { type: 'card', last4: '4242', brand: 'visa', fingerprint: 'x' } });

  it('only renders documented charge statuses', () => {
    const variants = [
      charge,
      { ...charge, status: 'succeeded' as const, amountReceived: charge.amount },
      { ...charge, status: 'failed' as const, failureReason: 'declined' as const },
      { ...charge, status: 'underpaid' as const },
      { ...charge, status: 'overpaid' as const, amountReceived: money(200n, 'NGN') },
      { ...charge, status: 'succeeded' as const, amountReceived: charge.amount, amountRefunded: money(50n, 'NGN') },
      { ...charge, status: 'succeeded' as const, amountReceived: charge.amount, amountRefunded: charge.amount },
    ];
    for (const v of variants) {
      expect(docs.statuses.charge.api).toContain(chargeStatus(v).status);
      if (v.status !== 'pending' && v.status !== 'failed') expect(docs.statuses.charge.webhook).toContain(webhookChargeStatus(v));
    }
  });

  it('uses refund status words', () => {
    const refund = { status: 'succeeded' } as Parameters<typeof refundStatus>[0];
    expect(docs.statuses.refund.values).toContain(refundStatus(refund));
    expect(refundStatus({ ...refund, status: 'pending' })).toBe('processing');
  });
});

function fakePayout() {
  return {
    id: 'po_1',
    ownerId: PLATFORM_OWNER,
    destinationId: 'dest_1',
    quoteId: null,
    amount: money(100n, 'NGN'),
    fee: money(0n, 'NGN'),
    status: 'completed' as const,
    failureReason: null,
    plannedOutcome: { kind: 'succeed' as const },
    inReview: false,
    reference: null,
    description: null,
    metadata: {},
    createdAt: '2026-11-21T10:00:00.000Z',
    processingAt: null,
    completedAt: '2026-11-21T10:00:05.000Z',
    failedAt: null,
    updatedAt: '2026-11-21T10:00:05.000Z',
  };
}
