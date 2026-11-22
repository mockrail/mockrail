import type { IdGenerator } from '../shared/ids.js';
import type { Store } from '../store/store.js';
import type { LedgerEntry, LedgerLine, LedgerTransaction } from './ledger-entry.js';

export const LEDGER_ENTRIES = 'ledger_entries';

export interface PostTransactionInput {
  readonly description: string;
  readonly reference?: string | null;
  readonly lines: readonly LedgerLine[];
}

/**
 * Posts a balanced double-entry transaction. Debits must equal credits per currency.
 * Entries are append-only; corrections are new transactions.
 */
export function postTransaction(
  store: Store,
  ids: IdGenerator,
  createdAt: string,
  input: PostTransactionInput,
): LedgerTransaction {
  const lines = input.lines.filter((line) => line.amount.amountMinor !== 0n);
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    if (line.amount.amountMinor < 0n) throw new Error('Ledger lines must use positive amounts');
    const signed = line.direction === 'debit' ? line.amount.amountMinor : -line.amount.amountMinor;
    totals.set(line.amount.currency, (totals.get(line.amount.currency) ?? 0n) + signed);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) throw new Error(`Unbalanced ledger transaction in ${currency}: off by ${total}`);
  }

  const transactionId = ids.next('ltx');
  const reference = input.reference ?? null;
  const entries: LedgerEntry[] = lines.map((line) => ({
    id: ids.next('le'),
    transactionId,
    account: line.account,
    direction: line.direction,
    amountMinor: line.amount.amountMinor,
    currency: line.amount.currency,
    description: input.description,
    reference,
    createdAt,
  }));
  for (const entry of entries) store.put(LEDGER_ENTRIES, entry);
  return { id: transactionId, description: input.description, reference, entries, createdAt };
}
