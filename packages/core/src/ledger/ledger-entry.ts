import type { CurrencyCode } from '../money/currency.js';
import type { Money } from '../money/money.js';

export type BalanceBucket = 'available' | 'pending' | 'reserved';

export type LedgerDirection = 'debit' | 'credit';

export interface LedgerLine {
  readonly account: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
}

export interface LedgerEntry {
  readonly id: string;
  readonly transactionId: string;
  readonly account: string;
  readonly direction: LedgerDirection;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly description: string;
  readonly reference: string | null;
  readonly createdAt: string;
}

export interface LedgerTransaction {
  readonly id: string;
  readonly description: string;
  readonly reference: string | null;
  readonly entries: readonly LedgerEntry[];
  readonly createdAt: string;
}

/** Ledger account names. Owner balance accounts are liabilities: credits increase them. */
export const ledgerAccounts = {
  balance: (ownerId: string, bucket: BalanceBucket): string => `owner:${ownerId}:${bucket}`,
  external: (rail: 'card_network' | 'bank_transfer' | 'crypto' | 'mobile_money' | 'payout_rail' | 'refunds'): string =>
    `external:${rail}`,
} as const;
