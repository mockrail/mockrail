import {
  applyFeeRule,
  isCurrencyCode,
  isPlatformOwner,
  localOf,
  SandboxError,
  type AdapterRequest,
  type CurrencyCode,
  type DestinationType,
  type FeeRule,
  type Money,
  type PayoutDestination,
  type PayoutStatus,
} from '@mockrail/core';
import { BACHS, NG_BANKS, PAYOUT_FEES, SANDBOX_RESOLVED_ACCOUNT_NAME } from '../constants.js';
import { bachsError } from '../errors.js';
import { convert, exchangeRate, toCurrency } from '../money.js';
import { BodyReader } from '../request.js';
import { outcomeForDestination } from '../test-triggers.js';
import { serializeDestination, serializePayout, serializeQuote } from '../view.js';
import { created, list, listWithTotal, noContent, ok, route, viewOf, type RouteFactory } from './helpers.js';

const TYPE_MAP: Readonly<Record<string, DestinationType>> = { bank_account: 'bank', mobile_money: 'mobile_money', crypto_wallet: 'crypto' };
const MOMO_CURRENCIES = ['GHS', 'KES', 'TZS'];
const CRYPTO = /^(USDT|USDC)_(TRC20|BEP20|ERC20|SOL|BASE)$/;
const REFERENCE = /^[A-Za-z0-9._-]{1,128}$/;
const PAYOUT_STATUSES = ['requested', 'pending', 'processing', 'approved', 'rejected', 'completed', 'failed'];
const EXTRA_FIELDS = ['sort_code', 'iban', 'swift_bic', 'routing_number', 'institution_number', 'transit_number', 'interac_email', 'scheme'] as const;

/** NGN bank payouts use the NGN balance; international banks, mobile money and crypto use USD (Payout currencies and methods). */
function fundingCurrencyFor(type: DestinationType, currency: string): CurrencyCode {
  return type === 'bank' && currency === 'NGN' ? 'NGN' : 'USD';
}

/** Core currency the destination receives (stablecoins are treated as USD 1:1). */
function deliveryCurrency(d: PayoutDestination): CurrencyCode {
  return d.type === 'crypto' ? 'USD' : (d.currency as CurrencyCode);
}

/** Withdrawal fee rule (Fees page). */
function payoutFeeRule(type: DestinationType, funding: CurrencyCode): FeeRule {
  if (type === 'crypto') return PAYOUT_FEES.crypto;
  if (type === 'mobile_money') return funding === 'USD' ? PAYOUT_FEES.usdMobileMoney : PAYOUT_FEES.otherMobileMoney;
  if (funding === 'NGN') return PAYOUT_FEES.ngnBank;
  if (funding === 'USD') return PAYOUT_FEES.usdBank;
  return PAYOUT_FEES.otherBank;
}

function isInternational(d: Pick<PayoutDestination, 'type' | 'currency' | 'country'>): boolean {
  if (d.type === 'mobile_money') return true;
  return d.type === 'bank' && (d.currency !== 'NGN' || (d.country !== null && d.country.toUpperCase() !== 'NG'));
}

/** Connected accounts: international payouts need the holder's name, contact email and address (Connect testing). */
function assertRecipientComplete(req: AdapterRequest, d: PayoutDestination): void {
  if (isPlatformOwner(req.ownerId) || !isInternational(d)) return;
  const account = req.sandbox.accounts.find(localOf(req.ownerId));
  const attrs = (account?.attributes ?? {}) as Record<string, unknown>;
  const missing = [
    !(account?.displayName || attrs.first_name) ? 'name' : null,
    !account?.email ? 'email' : null,
    !attrs.address ? 'address' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length) {
    throw new SandboxError('recipient_incomplete', `International payouts need the account holder's ${missing.join(', ')}.`, {
      fieldErrors: missing.map((m) => ({ field: m, message: 'Required for international payouts.' })),
    });
  }
}

/** Live: connected accounts need payouts.international (sandbox enables it on send). */
function assertInternationalEnabled(req: AdapterRequest, d: Pick<PayoutDestination, 'type' | 'currency' | 'country'>): void {
  if (isPlatformOwner(req.ownerId) || req.sandbox.config.fidelity !== 'live' || !isInternational(d)) return;
  const account = req.sandbox.accounts.find(localOf(req.ownerId));
  if (!account?.capabilities.payouts?.international) {
    throw bachsError('INTERNATIONAL_PAYOUTS_NOT_ENABLED', 400, 'International payouts are not enabled for this account.');
  }
}

function getDestination(req: AdapterRequest, id: string): PayoutDestination {
  const d = req.sandbox.payouts.findDestination(id);
  if (!d || d.ownerId !== req.ownerId) throw bachsError('PAYOUT_DESTINATION_NOT_FOUND', 404, `No payout destination found with id '${id}'.`);
  return d;
}

interface DestinationFields {
  name: string | null | undefined;
  type: DestinationType | undefined;
  currency: string | undefined;
  accountNumber: string | null | undefined;
  bankCode: string | null | undefined;
  accountName: string | null | undefined;
  bankName: string | null | undefined;
  phone: string | null | undefined;
  mobileProvider: string | null | undefined;
  walletAddress: string | null | undefined;
  network: string | null | undefined;
  details: Record<string, unknown>;
  metadata: Record<string, string> | undefined;
}

function readDestination(body: BodyReader): DestinationFields {
  const typeRaw = body.string('type') ?? body.string('destination_type');
  if (typeRaw && !TYPE_MAP[typeRaw]) body.fail('type', 'Must be bank_account, mobile_money or crypto_wallet.');
  const details: Record<string, unknown> = {};
  for (const field of EXTRA_FIELDS) {
    const v = body.nullableString(field);
    if (v !== undefined) details[field] = v;
  }
  const address = body.object('bank_address');
  if (address) {
    details.bank_address = {
      line1: address.nullableString('line1') ?? null,
      city: address.nullableString('city') ?? null,
      state: address.nullableString('state') ?? null,
      postal_code: address.nullableString('postal_code') ?? null,
      country: address.nullableString('country') ?? null,
    };
  }
  return {
    name: body.nullableString('name') ?? body.nullableString('label'),
    type: typeRaw ? TYPE_MAP[typeRaw] : undefined,
    currency: body.string('currency', { max: 10 })?.toUpperCase(),
    accountNumber: body.nullableString('account_number'),
    bankCode: body.nullableString('bank_code'),
    accountName: body.nullableString('account_name'),
    bankName: body.nullableString('bank_name'),
    phone: body.nullableString('phone_number'),
    mobileProvider: body.nullableString('mobile_provider'),
    walletAddress: body.nullableString('wallet_address'),
    network: body.nullableString('network'),
    details,
    metadata: body.metadata(),
  };
}

/** Required fields per route (Save and manage payout destinations; Payout currencies and methods). */
function validateRoute(f: Required<Pick<DestinationFields, 'type'>> & DestinationFields & { currency: string }): void {
  const missing = (fields: [string, unknown][]): void => {
    const absent = fields.filter(([, v]) => v === undefined || v === null || v === '').map(([k]) => k);
    if (absent.length) throw bachsError('VALIDATION_ERROR', 400, `Missing ${absent.join(', ')} for a ${f.currency} ${f.type === 'bank' ? 'bank_account' : f.type} destination.`, { field: absent[0] as string });
  };
  if (f.type === 'crypto') {
    if (!CRYPTO.test(f.currency)) throw bachsError('CURRENCY_NOT_SUPPORTED', 400, `${f.currency} is not a supported crypto payout asset.`, { field: 'currency' });
    return missing([['wallet_address', f.walletAddress]]);
  }
  if (f.type === 'mobile_money') {
    if (!MOMO_CURRENCIES.includes(f.currency)) throw bachsError('CURRENCY_NOT_SUPPORTED', 400, `Mobile money payouts are not available in ${f.currency}.`, { field: 'currency' });
    return missing([['mobile_provider', f.mobileProvider], ['phone_number', f.phone]]);
  }
  const d = f.details;
  switch (f.currency) {
    case 'NGN':
      return missing([['bank_code', f.bankCode], ['account_number', f.accountNumber]]);
    case 'GBP':
      return missing([['account_name', f.accountName], ['bank_name', f.bankName], ['sort_code', d.sort_code], ['account_number', f.accountNumber]]);
    case 'EUR':
      return missing([['account_name', f.accountName], ['bank_name', f.bankName], ['iban', d.iban], ['swift_bic', d.swift_bic]]);
    case 'USD':
      return missing([['scheme', d.scheme], ['account_name', f.accountName], ['bank_name', f.bankName], ['routing_number', d.routing_number], ['account_number', f.accountNumber], ['bank_address', d.bank_address]]);
    case 'CAD':
      return d.scheme === 'interac_email'
        ? missing([['account_name', f.accountName], ['interac_email', d.interac_email]])
        : missing([['scheme', d.scheme], ['account_name', f.accountName], ['bank_name', f.bankName], ['institution_number', d.institution_number], ['transit_number', d.transit_number], ['account_number', f.accountNumber]]);
    case 'GHS':
    case 'KES':
    case 'TZS':
    case 'UGX':
      return missing([['bank_code', f.bankCode], ['account_number', f.accountNumber], ['account_name', f.accountName]]);
    default:
      throw bachsError('CURRENCY_NOT_SUPPORTED', 400, `Bank payouts are not available in ${f.currency}.`, { field: 'currency' });
  }
}

/** Sandbox skips review; live sends crypto wallets to review. */
function initialStatus(req: AdapterRequest, type: DestinationType): 'pending_review' | 'approved' {
  return req.sandbox.config.fidelity === 'live' && type === 'crypto' ? 'pending_review' : 'approved';
}

function cleanNarration(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw bachsError('VALIDATION_ERROR', 400, 'narration cannot contain line breaks or control characters.', { field: 'narration' });
  const trimmed = raw.trim();
  if (trimmed.length > 100) throw bachsError('VALIDATION_ERROR', 400, 'narration must be at most 100 characters.', { field: 'narration' });
  return trimmed || null;
}

export const payoutRoutes: RouteFactory = (options) => [
  route('POST', '/v1/payouts/quotes', 'payouts.quote', (req) => {
    const body = new BodyReader(req.body);
    const from = body.currency('from_currency', { required: true });
    const toRaw = body.string('to_currency', { required: true });
    const amount = body.amount('amount', from, { required: true });
    const method = body.nullableString('payout_method')?.toUpperCase();
    body.done();
    const to = toRaw && CRYPTO.test(toRaw.toUpperCase()) ? 'USD' : toCurrency(toRaw);
    if (!to) throw bachsError('CURRENCY_NOT_SUPPORTED', 400, `${toRaw} is not a supported payout currency.`, { field: 'to_currency' });
    const type: DestinationType = method === 'MOBILE_MONEY' ? 'mobile_money' : method === 'CRYPTO' || (toRaw && CRYPTO.test(toRaw.toUpperCase())) ? 'crypto' : 'bank';
    const fee = applyFeeRule(payoutFeeRule(type, from!), amount!) as Money;
    const toAmount = convert({ amountMinor: amount!.amountMinor - fee.amountMinor, currency: from! }, to);
    const quote = req.sandbox.payouts.createQuote({ ownerId: req.ownerId, fromAmount: amount!, toAmount, exchangeRate: exchangeRate(from!, to), fee, ttlMs: BACHS.payoutQuoteTtlMs });
    return created(serializeQuote(quote));
  }),

  route('POST', '/v1/payouts/destinations', 'payouts.destinations.create', (req) => {
    const body = new BodyReader(req.body);
    const f = readDestination(body);
    if (!f.currency) body.fail('currency', 'This field is required.');
    body.done();
    const currency = f.currency as string;
    const type: DestinationType | undefined = f.type ?? (CRYPTO.test(currency) ? 'crypto' : isCurrencyCode(currency) ? 'bank' : undefined);
    if (!type) throw bachsError('DESTINATION_TYPE_REQUIRED', 400, 'Send type: bank_account, mobile_money or crypto_wallet.', { field: 'type' });
    validateRoute({ ...f, type, currency });
    assertInternationalEnabled(req, { type, currency, country: null });
    // NGN accounts are resolved: any supplied account_name and bank_name are ignored.
    const ngnBank = type === 'bank' && currency === 'NGN';
    const destination = req.sandbox.payouts.createDestination({
      ownerId: req.ownerId,
      type,
      currency,
      fundingCurrency: fundingCurrencyFor(type, currency),
      name: f.name ?? null,
      bankCode: f.bankCode ?? null,
      bankName: ngnBank ? (NG_BANKS[f.bankCode ?? ''] ?? 'Sandbox Bank') : (f.bankName ?? null),
      accountNumber: f.accountNumber ?? null,
      accountName: ngnBank ? SANDBOX_RESOLVED_ACCOUNT_NAME : (f.accountName ?? null),
      walletAddress: f.walletAddress ?? null,
      network: f.network ?? (type === 'crypto' ? (currency.split('_')[1] ?? null) : null),
      phone: f.phone ?? null,
      mobileProvider: f.mobileProvider ?? null,
      details: f.details,
      metadata: f.metadata ?? {},
      status: initialStatus(req, type),
    });
    return created(serializeDestination(destination));
  }),

  route('GET', '/v1/payouts/destinations', 'payouts.destinations.list', (req) => list(req, req.sandbox.payouts.listDestinations(req.ownerId), serializeDestination, 50)),

  route('GET', '/v1/payouts/destinations/:destination_id', 'payouts.destinations.retrieve', (req) => ok(serializeDestination(getDestination(req, req.params.destination_id ?? '')))),

  route('PATCH', '/v1/payouts/destinations/:destination_id', 'payouts.destinations.update', (req) => {
    const current = getDestination(req, req.params.destination_id ?? '');
    const body = new BodyReader(req.body);
    const isDefault = body.boolean('is_default');
    const f = readDestination(body);
    body.done();
    const routingFields = [f.accountNumber, f.bankCode, f.walletAddress, f.network, f.phone, f.currency, f.type, ...Object.values(f.details)].some((v) => v !== undefined);
    if (f.name === undefined && isDefault === undefined && !routingFields && f.accountName === undefined && f.bankName === undefined && f.mobileProvider === undefined) {
      throw bachsError('VALIDATION_ERROR', 400, 'Send name, is_default or routing details to update.');
    }
    if (f.name !== undefined && f.name !== null && f.name.length === 0) throw bachsError('VALIDATION_ERROR', 400, 'name cannot be empty.', { field: 'name' });
    const type = f.type ?? current.type;
    const currency = f.currency ?? current.currency;
    if (routingFields) {
      validateRoute({
        ...f,
        type,
        currency,
        accountNumber: f.accountNumber !== undefined ? f.accountNumber : current.accountNumber,
        bankCode: f.bankCode !== undefined ? f.bankCode : current.bankCode,
        accountName: f.accountName !== undefined ? f.accountName : current.accountName,
        bankName: f.bankName !== undefined ? f.bankName : current.bankName,
        phone: f.phone !== undefined ? f.phone : current.phone,
        mobileProvider: f.mobileProvider !== undefined ? f.mobileProvider : current.mobileProvider,
        walletAddress: f.walletAddress !== undefined ? f.walletAddress : current.walletAddress,
        details: { ...current.details, ...f.details },
      });
    }
    // Changing routing re-checks as if new; a rejected destination goes back to review.
    const recheck = routingFields ? (current.status === 'rejected' ? 'pending_review' : initialStatus(req, type)) : undefined;
    const destination = req.sandbox.payouts.updateDestination(req.ownerId, current.id, {
      ...(f.name !== undefined ? { name: f.name } : {}),
      ...(f.type ? { type } : {}),
      ...(f.currency ? { currency, fundingCurrency: fundingCurrencyFor(type, currency) } : {}),
      ...(f.accountNumber !== undefined ? { accountNumber: f.accountNumber } : {}),
      ...(f.bankCode !== undefined ? { bankCode: f.bankCode } : {}),
      ...(f.accountName !== undefined && !(type === 'bank' && currency === 'NGN') ? { accountName: f.accountName } : {}),
      ...(f.bankName !== undefined && !(type === 'bank' && currency === 'NGN') ? { bankName: f.bankName } : {}),
      ...(f.phone !== undefined ? { phone: f.phone } : {}),
      ...(f.mobileProvider !== undefined ? { mobileProvider: f.mobileProvider } : {}),
      ...(f.walletAddress !== undefined ? { walletAddress: f.walletAddress } : {}),
      ...(f.network !== undefined ? { network: f.network } : {}),
      ...(Object.keys(f.details).length ? { details: f.details } : {}),
      ...(f.metadata ? { metadata: f.metadata } : {}),
      ...(isDefault !== undefined && !routingFields ? { isDefault } : {}),
      ...(recheck ? { status: recheck } : {}),
    });
    return ok(serializeDestination(destination));
  }),

  route('DELETE', '/v1/payouts/destinations/:destination_id', 'payouts.destinations.delete', (req) => {
    const current = getDestination(req, req.params.destination_id ?? '');
    req.sandbox.payouts.deleteDestination(req.ownerId, current.id);
    return noContent();
  }),

  /** Exactly one of amount or quote_id. Responds 200 with the payout. */
  route('POST', '/v1/payouts', 'payouts.create', (req) => {
    const body = new BodyReader(req.body);
    const destinationId = body.string('destination', { required: true });
    const quoteId = body.nullableString('quote_id');
    const rawAmount = body.raw('amount');
    const reference = body.nullableString('reference');
    const narration = cleanNarration(body.nullableString('narration'));
    const metadata = body.metadata();
    body.done();
    if (reference && !REFERENCE.test(reference)) throw bachsError('VALIDATION_ERROR', 400, 'reference may use letters, digits, ".", "-" and "_" only (max 128).', { field: 'reference' });
    if (quoteId && rawAmount !== undefined && rawAmount !== null) throw bachsError('AMOUNT_NOT_ALLOWED_WITH_QUOTE', 400, 'Omit amount when sending quote_id.', { field: 'amount' });
    if (!quoteId && (rawAmount === undefined || rawAmount === null)) throw bachsError('AMOUNT_REQUIRED', 400, 'Provide amount or quote_id.', { field: 'amount' });

    const destination = getDestination(req, destinationId);
    if (destination.status !== 'approved') {
      throw bachsError(destination.status === 'rejected' ? 'DESTINATION_REJECTED' : 'PAYOUT_DESTINATION_NOT_APPROVED', 400, `The destination is ${destination.status}.`);
    }
    assertInternationalEnabled(req, destination);
    assertRecipientComplete(req, destination);

    let amount: Money | null = null;
    let fee: Money | undefined;
    if (!quoteId) {
      const delivery = deliveryCurrency(destination);
      if (delivery !== destination.fundingCurrency) {
        throw bachsError('QUOTE_REQUIRED', 400, `Payouts to ${destination.currency} are funded from ${destination.fundingCurrency}; create a quote first.`, { field: 'quote_id' });
      }
      const amountReader = new BodyReader({ amount: rawAmount });
      amount = amountReader.amount('amount', delivery, { required: true }) ?? null;
      amountReader.done();
      fee = applyFeeRule(payoutFeeRule(destination.type, destination.fundingCurrency), amount!) ?? undefined;
    }

    const outcomeOverride = req.scenarioOverride ?? outcomeForDestination(destination);
    const payout = req.sandbox.payouts.create({
      ownerId: req.ownerId,
      destinationId: destination.id,
      amount,
      quoteId: quoteId ?? null,
      ...(fee ? { fee } : {}),
      reference: reference ?? null,
      narration: narration ?? (destination.type === 'crypto' ? null : BACHS.payoutDefaultNarration),
      metadata: metadata ?? {},
      ...(outcomeOverride ? { outcomeOverride } : {}),
    });
    return ok(serializePayout(viewOf(req, options), payout));
  }),

  route('GET', '/v1/payouts', 'payouts.list', (req) => {
    const view = viewOf(req, options);
    const status = req.query.status_filter;
    if (status && !PAYOUT_STATUSES.includes(status)) throw bachsError('VALIDATION_ERROR', 400, `status_filter must be one of: ${PAYOUT_STATUSES.join(', ')}.`, { field: 'status_filter' });
    const reference = req.query.reference;
    if (reference !== undefined && !REFERENCE.test(reference)) throw bachsError('VALIDATION_ERROR', 400, 'reference has invalid characters.', { field: 'reference' });
    const items = req.sandbox.payouts.list(req.ownerId, {
      ...(status ? { status: status as PayoutStatus } : {}),
      ...(reference ? { reference } : {}),
    });
    return listWithTotal(req, items, (p) => serializePayout(view, p));
  }),

  route('GET', '/v1/payouts/:withdrawal_id', 'payouts.retrieve', (req) => ok(serializePayout(viewOf(req, options), req.sandbox.payouts.get(req.ownerId, req.params.withdrawal_id ?? '')))),
];
