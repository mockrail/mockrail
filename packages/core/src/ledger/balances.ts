import type { CurrencyCode } from '../money/currency.js';
import type { Money } from '../money/money.js';
import type { IdGenerator } from '../shared/ids.js';
import type { Store } from '../store/store.js';
import { ledgerAccounts, type BalanceBucket, type LedgerEntry, type LedgerLine, type LedgerTransaction } from './ledger-entry.js';
import { LEDGER_ENTRIES, postTransaction, type PostTransactionInput } from './post-entry.js';

export interface OwnerBalance {
  readonly currency: CurrencyCode;
  readonly available: bigint;
  readonly pending: bigint;
  readonly reserved: bigint;
  /** Funds held for review (e.g. over-limit deposits): neither available nor pending. */
  readonly held: bigint;
}

/** Balances are always derived from entries, never stored as a mutable number. */
export class Ledger {
  constructor(
    private readonly store: Store,
    private readonly ids: IdGenerator,
    private readonly nowIso: () => string,
  ) {}

  post(input: PostTransactionInput): LedgerTransaction {
    return postTransaction(this.store, this.ids, this.nowIso(), input);
  }

  /** Moves money between two accounts in one transaction. */
  move(from: string, to: string, amount: Money, description: string, reference?: string | null): LedgerTransaction {
    const lines: LedgerLine[] = [
      { account: from, direction: 'debit', amount },
      { account: to, direction: 'credit', amount },
    ];
    return this.post({ description, reference: reference ?? null, lines });
  }

  entries(filter?: { readonly account?: string; readonly reference?: string; readonly ownerId?: string }): LedgerEntry[] {
    const prefix = filter?.ownerId ? `owner:${filter.ownerId}:` : undefined;
    return this.store
      .list<LedgerEntry>(LEDGER_ENTRIES, (entry) => {
        if (filter?.account && entry.account !== filter.account) return false;
        if (filter?.reference && entry.reference !== filter.reference) return false;
        if (prefix && !entry.account.startsWith(prefix)) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Credit-normal balance of an account (credits minus debits). */
  accountBalance(account: string, currency: CurrencyCode): bigint {
    let total = 0n;
    for (const entry of this.store.list<LedgerEntry>(LEDGER_ENTRIES, (e) => e.account === account && e.currency === currency)) {
      total += entry.direction === 'credit' ? entry.amountMinor : -entry.amountMinor;
    }
    return total;
  }

  bucketBalance(ownerId: string, bucket: BalanceBucket, currency: CurrencyCode): bigint {
    return this.accountBalance(ledgerAccounts.balance(ownerId, bucket), currency);
  }

  balancesFor(ownerId: string): OwnerBalance[] {
    const prefix = `owner:${ownerId}:`;
    const byCurrency = new Map<CurrencyCode, { available: bigint; pending: bigint; reserved: bigint; held: bigint }>();
    for (const entry of this.store.list<LedgerEntry>(LEDGER_ENTRIES, (e) => e.account.startsWith(prefix))) {
      const bucket = entry.account.slice(prefix.length) as BalanceBucket;
      const row = byCurrency.get(entry.currency) ?? { available: 0n, pending: 0n, reserved: 0n, held: 0n };
      row[bucket] += entry.direction === 'credit' ? entry.amountMinor : -entry.amountMinor;
      byCurrency.set(entry.currency, row);
    }
    return [...byCurrency.entries()]
      .map(([currency, row]) => ({ currency, ...row }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }

  /** Sum of every entry per currency; always zero when the ledger is consistent. */
  trialBalance(): Map<CurrencyCode, bigint> {
    const totals = new Map<CurrencyCode, bigint>();
    for (const entry of this.store.list<LedgerEntry>(LEDGER_ENTRIES)) {
      const signed = entry.direction === 'debit' ? entry.amountMinor : -entry.amountMinor;
      totals.set(entry.currency, (totals.get(entry.currency) ?? 0n) + signed);
    }
    return totals;
  }
}
