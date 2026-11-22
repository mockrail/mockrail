import type { Random } from './random.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface IdGenerator {
  next(prefix: string): string;
  digits(length: number): string;
  secret(prefix: string): string;
}

export function createIdGenerator(random: Random): IdGenerator {
  const chars = (length: number, alphabet: string): string => {
    let out = '';
    for (let i = 0; i < length; i += 1) out += alphabet[random.int(alphabet.length)];
    return out;
  };
  return {
    next: (prefix) => `${prefix}_${chars(16, ALPHABET)}`,
    digits: (length) => chars(length, '0123456789'),
    secret: (prefix) => `${prefix}${chars(32, ALPHABET)}`,
  };
}
