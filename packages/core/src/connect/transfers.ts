import { ledgerAccounts } from '../ledger/ledger-entry.js';
import type { Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { isPlatformOwner, platformOf } from '../shared/owners.js';

export type TransferKind = 'payout' | 'manual';

export interface Transfer {
  readonly id: string;
  /** Owner debited. */
  readonly sourceOwner: string;
  /** Owner credited. */
  readonly destinationOwner: string;
  readonly amount: Money;
  readonly kind: TransferKind;
  readonly sourceChargeId: string | null;
  readonly transferGroup: string | null;
  readonly description: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
}

export interface PlatformFee {
  readonly id: string;
  readonly platformOwner: string;
  /** Owner the fee was collected from. */
  readonly collectedFrom: string;
  readonly chargeId: string;
  readonly amount: Money;
  readonly createdAt: string;
}

export interface CreateTransferInput {
  readonly sourceOwner: string;
  readonly destinationOwner: string;
  readonly amount: Money;
  readonly transferGroup?: string | null;
  readonly description?: string | null;
  readonly metadata?: Metadata;
}

export class TransfersService {
  constructor(private readonly ctx: CoreContext) {}

  /** A separate transfer from one owner's available balance to another in the same platform. */
  create(input: CreateTransferInput): Transfer {
    if (input.amount.amountMinor <= 0n) throw validationFailed([{ field: 'amount', message: 'Amount must be greater than zero.' }]);
    if (platformOf(input.sourceOwner) !== platformOf(input.destinationOwner)) throw notFound('account', input.destinationOwner);
    if (input.sourceOwner === input.destinationOwner) throw validationFailed([{ field: 'destination', message: 'Source and destination are the same.' }]);
    const available = this.ctx.ledger.bucketBalance(input.sourceOwner, 'available', input.amount.currency);
    if (available < input.amount.amountMinor) {
      throw new SandboxError('insufficient_balance', 'The available balance is too low for this transfer.', {
        details: { available: available.toString(), requested: input.amount.amountMinor.toString(), currency: input.amount.currency },
      });
    }
    const transfer = this.record({
      sourceOwner: input.sourceOwner,
      destinationOwner: input.destinationOwner,
      amount: input.amount,
      kind: 'manual',
      sourceChargeId: null,
      transferGroup: input.transferGroup ?? null,
      description: input.description ?? null,
      metadata: input.metadata ?? {},
    });
    this.ctx.ledger.move(
      ledgerAccounts.balance(input.sourceOwner, 'available'),
      ledgerAccounts.balance(input.destinationOwner, 'available'),
      input.amount,
      'transfer',
      transfer.id,
    );
    return transfer;
  }

  /** Records a transfer whose ledger movement was already posted as part of a charge. */
  recordFromCharge(input: { readonly fromOwner: string; readonly toOwner: string; readonly amount: Money; readonly chargeId: string }): Transfer {
    return this.record({
      sourceOwner: input.fromOwner,
      destinationOwner: input.toOwner,
      amount: input.amount,
      kind: 'payout',
      sourceChargeId: input.chargeId,
      transferGroup: null,
      description: null,
      metadata: {},
    });
  }

  recordPlatformFee(input: { readonly platformOwner: string; readonly collectedFrom: string; readonly chargeId: string; readonly amount: Money }): PlatformFee {
    const fee: PlatformFee = { id: this.ctx.ids.entity('platform_fee', input.platformOwner), ...input, createdAt: this.ctx.nowIso() };
    this.ctx.store.put(C.platformFees, fee);
    this.ctx.events.publish('platform_fee.created', input.platformOwner, { platformFee: fee });
    return fee;
  }

  get(platformOwner: string, id: string): Transfer {
    const transfer = this.ctx.store.get<Transfer>(C.transfers, id);
    if (!transfer || platformOf(transfer.sourceOwner) !== platformOwner) throw notFound('transfer', id);
    return transfer;
  }

  list(platformOwner: string, filter: { readonly owner?: string; readonly kind?: TransferKind } = {}): Transfer[] {
    return this.ctx.store
      .list<Transfer>(C.transfers, (t) => {
        if (platformOf(t.sourceOwner) !== platformOwner) return false;
        if (filter.owner && t.sourceOwner !== filter.owner && t.destinationOwner !== filter.owner) return false;
        if (filter.kind && t.kind !== filter.kind) return false;
        return true;
      })
      .sort(byNewest);
  }

  getPlatformFee(platformOwner: string, id: string): PlatformFee {
    const fee = this.ctx.store.get<PlatformFee>(C.platformFees, id);
    if (!fee || fee.platformOwner !== platformOwner) throw notFound('platform fee', id);
    return fee;
  }

  listPlatformFees(platformOwner: string, filter: { readonly chargeId?: string } = {}): PlatformFee[] {
    return this.ctx.store
      .list<PlatformFee>(C.platformFees, (f) => f.platformOwner === platformOwner && (!filter.chargeId || f.chargeId === filter.chargeId))
      .sort(byNewest);
  }

  private record(fields: Omit<Transfer, 'id' | 'createdAt'>): Transfer {
    const transfer: Transfer = { id: this.ctx.ids.entity('transfer', platformOf(fields.sourceOwner)), ...fields, createdAt: this.ctx.nowIso() };
    this.ctx.store.put(C.transfers, transfer);
    // The connected account is the origin in both directions.
    const origin = isPlatformOwner(fields.destinationOwner) ? fields.sourceOwner : fields.destinationOwner;
    this.ctx.events.publish('transfer.created', origin, { transfer });
    return transfer;
  }
}
