import { isPlatformOwner, localOf } from '@mockrail/core';
import { BACHS, COLLECTION_FEES } from '../constants.js';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { serializeVirtualAccount } from '../view.js';
import { ok, route, type RouteFactory } from './helpers.js';

export const virtualAccountRoutes: RouteFactory = () => [
  /** One permanent NGN account per account; repeat calls return the same number (200). */
  route('POST', '/v1/virtual-accounts', 'virtual_accounts.create', (req) => {
    const body = new BodyReader(req.body);
    const rawCurrency = body.string('currency', { required: true });
    const bankCode = body.string('bank_code');
    body.done();
    if (rawCurrency.length !== 3) throw bachsError('VALIDATION_ERROR', 400, 'currency must be a three-letter code.', { field: 'currency' });
    if (rawCurrency.toUpperCase() !== 'NGN') throw bachsError('VIRTUAL_ACCOUNT_CURRENCY_NOT_SUPPORTED', 400, `Virtual accounts are not available in ${rawCurrency.toUpperCase()}`);
    if (bankCode && !BACHS.virtualAccountBanks[bankCode]) {
      throw bachsError('VALIDATION_ERROR', 400, `bank_code must be one of: ${Object.keys(BACHS.virtualAccountBanks).join(', ')}.`, { field: 'bank_code' });
    }
    const account = isPlatformOwner(req.ownerId) ? null : req.sandbox.accounts.find(localOf(req.ownerId));
    const { account: va } = req.sandbox.virtualAccounts.create({
      ownerId: req.ownerId,
      currency: 'NGN',
      accountName: account?.displayName ?? 'Sandbox Merchant',
      // In the sandbox the bank name is always "Sandbox Test Bank"; bank_code is the one sent or picked.
      bankName: BACHS.virtualAccountSandboxBankName,
      bankCode: bankCode ?? '103',
      numberPrefix: BACHS.virtualAccountPrefix,
      numberLength: BACHS.virtualAccountLength,
      perDepositLimitMinor: BACHS.ngnDepositLimitMinor,
      dailyLimitMinor: BACHS.ngnDepositLimitMinor,
      depositFeeRule: COLLECTION_FEES.VIRTUAL_ACCOUNT_DEPOSIT ?? null,
    });
    return ok(serializeVirtualAccount(va));
  }),

  route('GET', '/v1/virtual-accounts', 'virtual_accounts.retrieve', (req) => {
    const currency = (req.query.currency ?? 'NGN').toUpperCase();
    if (currency.length !== 3) throw bachsError('VALIDATION_ERROR', 400, 'currency must be a three-letter code.', { field: 'currency' });
    const va = currency === 'NGN' ? req.sandbox.virtualAccounts.find(req.ownerId, 'NGN') : null;
    if (!va) throw bachsError('NOT_FOUND', 404, `No virtual account in ${currency}.`);
    return ok(serializeVirtualAccount(va));
  }),
];
