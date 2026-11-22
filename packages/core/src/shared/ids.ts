import { providerOf } from './owners.js';
import type { Random } from './random.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const HEX = '0123456789abcdef';

/** Every kind of record the core creates. Adapters can rename the ID prefix per kind. */
export type EntityKind =
  | 'customer'
  | 'payment_method'
  | 'product'
  | 'checkout'
  | 'charge'
  | 'virtual_account'
  | 'subscription'
  | 'subscription_item'
  | 'invoice'
  | 'refund'
  | 'payout_destination'
  | 'payout_quote'
  | 'payout'
  | 'account'
  | 'account_link'
  | 'person'
  | 'document'
  | 'transfer'
  | 'platform_fee'
  | 'webhook_endpoint'
  | 'webhook_attempt';

export const DEFAULT_PREFIXES: Readonly<Record<EntityKind, string>> = {
  customer: 'cus',
  payment_method: 'pm',
  product: 'prod',
  checkout: 'cs',
  charge: 'ch',
  virtual_account: 'va',
  subscription: 'sub',
  subscription_item: 'si',
  invoice: 'in',
  refund: 're',
  payout_destination: 'dest',
  payout_quote: 'quote',
  payout: 'po',
  account: 'acct',
  account_link: 'alnk',
  person: 'person',
  document: 'doc',
  transfer: 'tr',
  platform_fee: 'fee',
  webhook_endpoint: 'we',
  webhook_attempt: 'whd',
};

export interface IdFormat {
  readonly prefix: string;
  /** 'base62' (default) or 'hex' bodies. */
  readonly alphabet?: 'base62' | 'hex';
  readonly length?: number;
}

export type IdFormats = Partial<Record<EntityKind, string | IdFormat>>;

export interface IdGenerator {
  next(prefix: string): string;
  /** ID for a record owned by `owner`, using that owner's provider prefix for the kind. */
  entity(kind: EntityKind, owner: string): string;
  registerProvider(providerId: string, formats: IdFormats): void;
  digits(length: number): string;
  hex(length: number): string;
  secret(prefix: string, options?: { readonly alphabet?: 'base62' | 'hex'; readonly length?: number }): string;
}

export function createIdGenerator(random: Random): IdGenerator {
  const chars = (length: number, alphabet: string): string => {
    let out = '';
    for (let i = 0; i < length; i += 1) out += alphabet[random.int(alphabet.length)];
    return out;
  };
  const providers = new Map<string, IdFormats>();
  return {
    next: (prefix) => `${prefix}_${chars(16, ALPHABET)}`,
    entity(kind, owner) {
      const custom = providers.get(providerOf(owner))?.[kind];
      const format: IdFormat = typeof custom === 'string' ? { prefix: custom } : (custom ?? { prefix: DEFAULT_PREFIXES[kind] });
      return `${format.prefix}_${chars(format.length ?? 16, format.alphabet === 'hex' ? HEX : ALPHABET)}`;
    },
    registerProvider(providerId, formats) {
      providers.set(providerId, formats);
    },
    digits: (length) => chars(length, '0123456789'),
    hex: (length) => chars(length, HEX),
    secret: (prefix, options = {}) => `${prefix}${chars(options.length ?? 32, options.alphabet === 'hex' ? HEX : ALPHABET)}`,
  };
}
