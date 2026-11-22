import type { Charge, ChargesService } from '../charges/charges.js';
import type { CustomersService } from '../customers/customers.js';
import type { CurrencyCode } from '../money/currency.js';
import type { Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed } from '../shared/errors.js';

export interface VirtualAccount {
  readonly id: string;
  readonly ownerId: string;
  readonly customerId: string | null;
  readonly currency: CurrencyCode;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankName: string;
  /** Deposits above this many minor units are held. Null = no limit. */
  readonly perDepositLimitMinor: bigint | null;
  /** Deposits that push the UTC-day total above this are held. Null = no limit. */
  readonly dailyLimitMinor: bigint | null;
  readonly createdAt: string;
}

export interface CreateVirtualAccountInput {
  readonly ownerId: string;
  readonly currency: CurrencyCode;
  readonly customerId?: string | null;
  readonly accountName?: string | null;
  /** Provider-specific presentation, supplied by the adapter. */
  readonly bankName: string;
  readonly numberPrefix: string;
  readonly numberLength: number;
  readonly perDepositLimitMinor?: bigint | null;
  readonly dailyLimitMinor?: bigint | null;
}

export interface SimulateDepositInput {
  readonly accountNumber: string;
  readonly amount: Money;
  readonly senderName?: string | null;
  readonly senderAccountNumber?: string | null;
  readonly senderBankName?: string | null;
  readonly reference?: string | null;
}

const RELEASE_JOB = 'deposit.release';

export class VirtualAccountsService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly customers: CustomersService,
    private readonly charges: ChargesService,
  ) {
    ctx.scheduler.register<{ chargeId: string }>(RELEASE_JOB, ({ chargeId }) => {
      const charge = this.charges.find(chargeId);
      if (charge?.settlement === 'held') this.charges.releaseHeld(chargeId);
    });
  }

  /** Returns the existing account for the same owner, currency and customer, so repeat calls give the same number. */
  create(input: CreateVirtualAccountInput): VirtualAccount {
    const customerId = input.customerId ?? null;
    if (customerId) this.customers.get(input.ownerId, customerId);
    const existing = this.ctx.store.list<VirtualAccount>(
      C.virtualAccounts,
      (va) => va.ownerId === input.ownerId && va.currency === input.currency && va.customerId === customerId,
    )[0];
    if (existing) return existing;

    const customer = this.customers.find(customerId);
    const account: VirtualAccount = {
      id: this.ctx.ids.next('va'),
      ownerId: input.ownerId,
      customerId,
      currency: input.currency,
      accountNumber: this.uniqueNumber(input.numberPrefix, input.numberLength),
      accountName: input.accountName ?? customer?.name ?? 'Sandbox Merchant',
      bankName: input.bankName,
      perDepositLimitMinor: input.perDepositLimitMinor ?? null,
      dailyLimitMinor: input.dailyLimitMinor ?? null,
      createdAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.virtualAccounts, account);
    this.ctx.events.publish('virtual_account.created', account.ownerId, { virtualAccount: account });
    return account;
  }

  list(ownerId: string, filter: { readonly currency?: CurrencyCode; readonly customerId?: string } = {}): VirtualAccount[] {
    return this.ctx.store
      .list<VirtualAccount>(C.virtualAccounts, (va) => {
        if (va.ownerId !== ownerId) return false;
        if (filter.currency && va.currency !== filter.currency) return false;
        if (filter.customerId && va.customerId !== filter.customerId) return false;
        return true;
      })
      .sort(byNewest);
  }

  find(id: string | null | undefined): VirtualAccount | null {
    return id ? this.ctx.store.get<VirtualAccount>(C.virtualAccounts, id) ?? null : null;
  }

  findByNumber(accountNumber: string): VirtualAccount | null {
    return this.ctx.store.list<VirtualAccount>(C.virtualAccounts, (va) => va.accountNumber === accountNumber)[0] ?? null;
  }

  /** Simulates a bank transfer into a virtual account (a control-plane action). */
  simulateDeposit(input: SimulateDepositInput): Charge {
    const account = this.findByNumber(input.accountNumber);
    if (!account) throw notFound('virtual account', input.accountNumber);
    if (input.amount.currency !== account.currency) {
      throw validationFailed([{ field: 'currency', message: `This account receives ${account.currency}.` }]);
    }
    if (input.amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);

    const outcome = this.ctx.scenarios.decide({
      operation: 'deposit.receive',
      references: [account.id, account.accountNumber, input.reference],
      ownerId: account.ownerId,
      currency: account.currency,
    });
    if (outcome.kind === 'fail') throw new SandboxError('bad_request', `Deposit rejected by scenario: ${outcome.reason}.`);

    const overLimit = this.isOverLimit(account, input.amount.amountMinor);
    const held = overLimit || outcome.kind === 'delay';
    const charge = this.charges.recordDeposit({
      ownerId: account.ownerId,
      amount: outcome.kind === 'partial' ? outcome.receivedAmount : input.amount,
      virtualAccountId: account.id,
      customerId: account.customerId,
      reference: input.reference ?? null,
      held,
      paymentMethod: {
        type: 'bank_transfer',
        senderName: input.senderName ?? 'Sandbox Sender',
        senderAccountNumber: input.senderAccountNumber ?? '0123456789',
        senderBankName: input.senderBankName ?? 'Sandbox Sender Bank',
      },
    });
    if (outcome.kind === 'delay' && !overLimit) {
      this.ctx.scheduler.schedule(RELEASE_JOB, new Date(this.ctx.now().getTime() + outcome.settleAfterMs), { chargeId: charge.id });
    }
    return charge;
  }

  private isOverLimit(account: VirtualAccount, amountMinor: bigint): boolean {
    if (account.perDepositLimitMinor !== null && amountMinor > account.perDepositLimitMinor) return true;
    if (account.dailyLimitMinor === null) return false;
    const dayStart = new Date(this.ctx.now());
    dayStart.setUTCHours(0, 0, 0, 0);
    const today = this.charges
      .list(account.ownerId, { source: 'deposit' })
      .filter((c) => c.virtualAccountId === account.id && Date.parse(c.createdAt) >= dayStart.getTime())
      .reduce((sum, c) => sum + c.amountReceived.amountMinor, 0n);
    return today + amountMinor > account.dailyLimitMinor;
  }

  private uniqueNumber(prefix: string, length: number): string {
    for (let i = 0; i < 100; i += 1) {
      const candidate = prefix + this.ctx.ids.digits(Math.max(0, length - prefix.length));
      if (!this.findByNumber(candidate)) return candidate;
    }
    throw new Error('Could not allocate a unique virtual account number');
  }
}
