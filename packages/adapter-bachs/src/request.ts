import {
  isCurrencyCode,
  parseDecimal,
  SandboxError,
  validationFailed,
  type CurrencyCode,
  type FieldError,
  type Metadata,
  type Money,
} from '@mockrail/core';

type Json = Record<string, unknown>;

/**
 * Reads a Bachs request body field by field and collects every error,
 * so one response lists all invalid fields.
 */
export class BodyReader {
  private readonly data: Json;

  constructor(
    body: unknown,
    private readonly prefix = '',
    private readonly errors: FieldError[] = [],
  ) {
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      throw new SandboxError('bad_request', 'The request body must be a JSON object.');
    }
    this.data = (body ?? {}) as Json;
  }

  has(field: string): boolean {
    return this.data[field] !== undefined;
  }

  raw(field: string): unknown {
    return this.data[field];
  }

  string(field: string, options: { required: true; max?: number }): string;
  string(field: string, options?: { required?: false; max?: number }): string | undefined;
  string(field: string, options: { required?: boolean; max?: number } = {}): string | undefined {
    const value = this.data[field];
    if (value === undefined || value === null || value === '') {
      if (options.required) this.fail(field, 'This field is required.');
      return undefined;
    }
    if (typeof value !== 'string') {
      this.fail(field, 'Must be a string.');
      return undefined;
    }
    if (options.max && value.length > options.max) this.fail(field, `Must be at most ${options.max} characters.`);
    return value;
  }

  nullableString(field: string): string | null | undefined {
    if (this.data[field] === null) return null;
    return this.string(field);
  }

  integer(field: string, options: { min?: number; max?: number } = {}): number | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.fail(field, 'Must be an integer.');
      return undefined;
    }
    if (options.min !== undefined && value < options.min) this.fail(field, `Must be at least ${options.min}.`);
    if (options.max !== undefined && value > options.max) this.fail(field, `Must be at most ${options.max}.`);
    return value;
  }

  boolean(field: string): boolean | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
      this.fail(field, 'Must be true or false.');
      return undefined;
    }
    return value;
  }

  oneOf<T extends string>(field: string, allowed: readonly T[], options: { required?: boolean } = {}): T | undefined {
    const value = this.data[field];
    if (value === undefined || value === null || value === '') {
      if (options.required) this.fail(field, 'This field is required.');
      return undefined;
    }
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      this.fail(field, `Must be one of: ${allowed.join(', ')}.`);
      return undefined;
    }
    return value as T;
  }

  currency(field = 'currency', options: { required?: boolean } = {}): CurrencyCode | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) {
      if (options.required) this.fail(field, 'This field is required.');
      return undefined;
    }
    const upper = typeof value === 'string' ? value.toUpperCase() : value;
    if (!isCurrencyCode(upper)) {
      this.fail(field, 'Unsupported currency. The sandbox supports NGN, USD, GHS, KES and ZAR.');
      return undefined;
    }
    return upper;
  }

  /** A decimal-string amount in the major unit ("29.00"). */
  amount(field: string, currency: CurrencyCode | undefined, options: { required?: boolean; allowZero?: boolean } = {}): Money | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) {
      if (options.required) this.fail(field, 'This field is required.');
      return undefined;
    }
    if (!currency) return undefined;
    const minor = parseDecimal(value, currency);
    if (minor === null) {
      this.fail(field, 'Must be a decimal string in the major unit with at most two decimal places, e.g. "29.00".');
      return undefined;
    }
    if (minor < 0n || (minor === 0n && !options.allowZero)) {
      this.fail(field, 'Must be greater than zero.');
      return undefined;
    }
    return { amountMinor: minor, currency };
  }

  metadata(field = 'metadata'): Metadata | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.fail(field, 'Must be an object of string values.');
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [key, v] of Object.entries(value)) {
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
        this.fail(`${field}.${key}`, 'Metadata values must be strings.');
        continue;
      }
      out[key] = String(v);
    }
    return out;
  }

  stringArray(field: string): string[] | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      this.fail(field, 'Must be an array of strings.');
      return undefined;
    }
    return value as string[];
  }

  object(field: string): BodyReader | undefined {
    const value = this.data[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
      this.fail(field, 'Must be an object.');
      return undefined;
    }
    return new BodyReader(value, `${this.prefix}${field}.`, this.errors);
  }

  fail(field: string, message: string): void {
    this.errors.push({ field: `${this.prefix}${field}`, message });
  }

  /** Throws one validation error listing every problem found. */
  done(): void {
    if (this.errors.length) throw validationFailed(this.errors);
  }
}

export function queryInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new SandboxError('bad_request', `'${value}' is not an integer.`);
  return n;
}
