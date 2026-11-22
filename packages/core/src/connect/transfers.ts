import { ledgerAccounts } from '../ledger/ledger-entry.js';
import type { Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { PLATFORM_OWNER } from '../shared/owners.js';
import type { AccountsService } from './accounts.js';

export interface Transfer {
  readonly id: string;
  /** Who the money left (the platform). */
  readonly ownerId: string;
  readonly destination: string;
  readonly amount: Money;
  readonly sourceChargeId: string | null;
  readonly description: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
}

export interface PlatformFee {
  readonly id: string;
  /** Connected account the fee was collected from. */
  readonly accountId: string;
  readonly chargeId: string;
  readonly amount: Money;
  readonly createdAt: string;
}

export interface CreateTransferInput {
  readonly destination: string;
  readonly amount: Money;
  readonly description?: string | null;
  readonly metadata?: Metadata;
}

export class TransfersService {
  constructor(
    private readonly ctx: CoreContext,
    private readonly accounts: AccountsService,
  ) {}

  /** A separate transfer from the platform's available balance to a connected account. */
  create(input: CreateTransferInput): Transfer {
    if (input.amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
    this.accounts.get(input.destination);
    const available = this.ctx.ledger.bucketBalance(PLATFORM_OWNER, 'available', input.amount.currency);
    if (available < input.amount.amountMinor) {
      throw new SandboxError('insufficient_balance', 'The platform balance is too low for this transfer.', {
        details: { available: available.toString(), requested: input.amount.amountMinor.toString(), currency: input.amount.currency },
      });
    }
    const transfer = this.record({ destination: input.destination, amount: input.amount, sourceChargeId: null, description: input.description ?? null, metadata: input.metadata ?? {} });
    this.ctx.ledger.move(
      ledgerAccounts.balance(PLATFORM_OWNER, 'available'),
      ledgerAccounts.balance(input.destination, 'available'),
      input.amount,
      'transfer',
      transfer.id,
    );
    return transfer;
  }

  /** Records a transfer whose ledger movement was already posted as part of a charge. */
  recordFromCharge(input: { readonly destination: string; readonly amount: Money; readonly chargeId: string }): Transfer {
    return this.record({ destination: input.destination, amount: input.amount, sourceChargeId: input.chargeId, description: null, metadata: {} });
  }

  recordPlatformFee(input: { readonly accountId: string; readonly chargeId: string; readonly amount: Money }): PlatformFee {
    const fee: PlatformFee = { id: this.ctx.ids.next('fee'), ...input, createdAt: this.ctx.nowIso() };
    this.ctx.store.put(C.platformFees, fee);
    this.ctx.events.publish('platform_fee.created', PLATFORM_OWNER, { platformFee: fee });
    return fee;
  }

  get(id: string): Transfer {
    const transfer = this.ctx.store.get<Transfer>(C.transfers, id);
    if (!transfer) throw notFound('transfer', id);
    return transfer;
  }

  list(filter: { readonly destination?: string } = {}): Transfer[] {
    return this.ctx.store.list<Transfer>(C.transfers, (t) => !filter.destination || t.destination === filter.destination).sort(byNewest);
  }

  getPlatformFee(id: string): PlatformFee {
    const fee = this.ctx.store.get<PlatformFee>(C.platformFees, id);
    if (!fee) throw notFound('platform fee', id);
    return fee;
  }

  listPlatformFees(filter: { readonly accountId?: string } = {}): PlatformFee[] {
    return this.ctx.store.list<PlatformFee>(C.platformFees, (f) => !filter.accountId || f.accountId === filter.accountId).sort(byNewest);
  }

  private record(fields: Omit<Transfer, 'id' | 'ownerId' | 'createdAt'>): Transfer {
    const transfer: Transfer = { id: this.ctx.ids.next('tr'), ownerId: PLATFORM_OWNER, ...fields, createdAt: this.ctx.nowIso() };
    this.ctx.store.put(C.transfers, transfer);
    this.ctx.events.publish('transfer.created', transfer.destination, { transfer });
    return transfer;
  }
}
