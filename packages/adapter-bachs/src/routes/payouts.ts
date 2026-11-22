import { SandboxError, type CurrencyCode, type DestinationType, type PayoutDestination, type PayoutStatus, type Recipient } from '@mockrail/core';
import { BACHS } from '../constants.js';
import { BodyReader } from '../request.js';
import { serializeDestination, serializePayout, serializeQuote } from '../serializers.js';
import { outcomeForDestination } from '../test-triggers.js';
import { created, list, ok, route, type RouteFactory } from './helpers.js';

const TYPES: readonly DestinationType[] = ['bank', 'crypto', 'mobile_money'];
const STATUSES: readonly PayoutStatus[] = ['pending', 'processing', 'completed', 'failed'];

/** International payouts need the recipient's name, email and address (Connect testing page). */
function isInternational(destination: PayoutDestination): boolean {
  if (destination.type !== 'bank') return false;
  return destination.currency !== 'NGN' || (destination.country !== null && destination.country.toUpperCase() !== 'NG');
}

function assertRecipientComplete(destination: PayoutDestination): void {
  if (!isInternational(destination)) return;
  const r = destination.recipient;
  const missing = (['name', 'email', 'address'] as const).filter((field) => !r?.[field]);
  if (missing.length) {
    throw new SandboxError('recipient_incomplete', `International payouts need the recipient's ${missing.join(', ')}.`, {
      fieldErrors: missing.map((field) => ({ field: `recipient.${field}`, message: 'Required for international payouts.' })),
    });
  }
}

export const payoutRoutes: RouteFactory = () => [
  route('POST', '/v1/payouts/quotes', 'payouts.quote', (req) => {
    const body = new BodyReader(req.body);
    const destinationId = body.string('destination_id');
    const destination = destinationId ? req.sandbox.payouts.getDestination(req.ownerId, destinationId) : null;
    const currency: CurrencyCode | undefined = body.currency('currency', { required: !destination }) ?? destination?.currency;
    const amount = body.amount('amount', currency, { required: true });
    body.done();
    // Quotes last 30 seconds.
    const quote = req.sandbox.payouts.createQuote({ ownerId: req.ownerId, amount: amount!, destinationId: destinationId ?? null, ttlMs: BACHS.payoutQuoteTtlMs });
    return created(serializeQuote(quote));
  }),

  route('POST', '/v1/payouts/destinations', 'payouts.destinations.create', (req) => {
    const body = new BodyReader(req.body);
    const type = body.oneOf('type', TYPES, { required: true });
    const currency = body.currency('currency', { required: true });
    const country = body.string('country', { max: 2 });
    const recipientBody = body.object('recipient');
    const recipient: Recipient | null = recipientBody
      ? { name: recipientBody.string('name') ?? null, email: recipientBody.string('email') ?? null, address: recipientBody.string('address') ?? null }
      : null;
    const fields = {
      bankCode: body.string('bank_code') ?? null,
      bankName: body.string('bank_name') ?? null,
      accountNumber: body.string('account_number') ?? null,
      // The official sandbox accepts any account name; live requires a match (use a scenario to simulate a mismatch).
      accountName: body.string('account_name') ?? null,
      cryptoAddress: body.string('address') ?? null,
      network: body.string('network') ?? null,
      phone: body.string('phone_number') ?? null,
      mobileProvider: body.string('provider') ?? null,
    };
    const metadata = body.metadata();
    body.done();
    const destination = req.sandbox.payouts.createDestination({
      ownerId: req.ownerId,
      type: type!,
      currency: currency!,
      country: country ?? null,
      recipient,
      metadata: metadata ?? {},
      ...fields,
    });
    return created(serializeDestination(destination));
  }),

  route('GET', '/v1/payouts/destinations', 'payouts.destinations.list', (req) =>
    list(req, req.sandbox.payouts.listDestinations(req.ownerId), serializeDestination),
  ),

  route('GET', '/v1/payouts/destinations/:destination_id', 'payouts.destinations.retrieve', (req) =>
    ok(serializeDestination(req.sandbox.payouts.getDestination(req.ownerId, req.params.destination_id ?? ''))),
  ),

  route('DELETE', '/v1/payouts/destinations/:destination_id', 'payouts.destinations.delete', (req) =>
    ok({ ...serializeDestination(req.sandbox.payouts.deleteDestination(req.ownerId, req.params.destination_id ?? '')), deleted: true }),
  ),

  route('POST', '/v1/payouts', 'payouts.create', (req) => {
    const body = new BodyReader(req.body);
    const destinationId = body.string('destination_id', { required: true });
    const quoteId = body.string('quote_id');
    const destination = destinationId ? req.sandbox.payouts.getDestination(req.ownerId, destinationId) : undefined;
    const currency = body.currency('currency') ?? destination?.currency;
    const amount = quoteId ? undefined : body.amount('amount', currency, { required: true });
    const reference = body.string('reference');
    const description = body.string('description');
    const metadata = body.metadata();
    body.done();
    if (!destination) throw new SandboxError('bad_request', 'destination_id is required.');

    assertRecipientComplete(destination);
    const outcomeOverride = req.scenarioOverride ?? outcomeForDestination(destination);
    const payout = req.sandbox.payouts.create({
      ownerId: req.ownerId,
      destinationId: destination.id,
      amount: amount ?? null,
      quoteId: quoteId ?? null,
      reference: reference ?? null,
      description: description ?? null,
      metadata: metadata ?? {},
      ...(outcomeOverride ? { outcomeOverride } : {}),
    });
    return created(serializePayout(payout));
  }),

  route('GET', '/v1/payouts', 'payouts.list', (req) => {
    const status = STATUSES.find((s) => s === req.query.status);
    return list(req, req.sandbox.payouts.list(req.ownerId, status ? { status } : {}), serializePayout);
  }),

  route('GET', '/v1/payouts/:withdrawal_id', 'payouts.retrieve', (req) =>
    ok(serializePayout(req.sandbox.payouts.get(req.ownerId, req.params.withdrawal_id ?? ''))),
  ),
];
