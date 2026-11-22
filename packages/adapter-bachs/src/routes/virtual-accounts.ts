import { isCurrencyCode, SandboxError } from '@mockrail/core';
import { BACHS } from '../constants.js';
import { BodyReader } from '../request.js';
import { serializeVirtualAccount } from '../serializers.js';
import { list, ok, route, type RouteFactory } from './helpers.js';

export const virtualAccountRoutes: RouteFactory = () => [
  // Repeat calls return the same account number.
  route('POST', '/v1/virtual-accounts', 'virtual_accounts.create', (req) => {
    const body = new BodyReader(req.body);
    const currency = body.currency('currency') ?? 'NGN';
    const customerId = body.string('customer_id');
    const accountName = body.string('account_name');
    body.done();
    const ngn = currency === 'NGN';
    const account = req.sandbox.virtualAccounts.create({
      ownerId: req.ownerId,
      currency,
      customerId: customerId ?? null,
      accountName: accountName ?? null,
      bankName: BACHS.virtualAccountBankName,
      numberPrefix: BACHS.virtualAccountPrefix,
      numberLength: BACHS.virtualAccountLength,
      perDepositLimitMinor: ngn ? BACHS.ngnDepositLimitMinor : null,
      dailyLimitMinor: ngn ? BACHS.ngnDepositLimitMinor : null,
    });
    return ok(serializeVirtualAccount(account));
  }),

  route('GET', '/v1/virtual-accounts', 'virtual_accounts.list', (req) => {
    const raw = req.query.currency?.toUpperCase();
    if (raw && !isCurrencyCode(raw)) throw new SandboxError('bad_request', `Unsupported currency '${req.query.currency}'.`);
    const filter = raw && isCurrencyCode(raw) ? { currency: raw } : {};
    return list(req, req.sandbox.virtualAccounts.list(req.ownerId, filter), serializeVirtualAccount);
  }),
];
