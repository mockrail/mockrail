import type { Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, validationFailed, type FieldError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export type RecurringInterval = 'day' | 'week' | 'month' | 'year';

export interface Recurring {
  readonly interval: RecurringInterval;
  readonly intervalCount: number;
  readonly trialDays: number;
}

export interface Product {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string | null;
  readonly price: Money;
  readonly recurring: Recurring | null;
  readonly archived: boolean;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProductInput {
  readonly ownerId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly price: Money;
  readonly recurring?: Recurring | null;
  readonly metadata?: Metadata;
}

export interface UpdateProductInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly price?: Money;
  readonly metadata?: Metadata;
}

const INTERVALS: readonly RecurringInterval[] = ['day', 'week', 'month', 'year'];

export class ProductsService {
  constructor(private readonly ctx: CoreContext) {}

  create(input: CreateProductInput): Product {
    validateProduct(input);
    const now = this.ctx.nowIso();
    const product: Product = {
      id: this.ctx.ids.next('prod'),
      ownerId: input.ownerId,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      recurring: input.recurring ?? null,
      archived: false,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.products, product);
    this.ctx.events.publish('product.created', product.ownerId, { product });
    return product;
  }

  get(ownerId: string, id: string): Product {
    const product = this.ctx.store.get<Product>(C.products, id);
    if (!product || product.ownerId !== ownerId) throw notFound('product', id);
    return product;
  }

  list(ownerId: string, filter: { readonly archived?: boolean } = {}): Product[] {
    return this.ctx.store
      .list<Product>(C.products, (p) => p.ownerId === ownerId && (filter.archived === undefined || p.archived === filter.archived))
      .sort(byNewest);
  }

  update(ownerId: string, id: string, patch: UpdateProductInput): Product {
    const current = this.get(ownerId, id);
    const next: Product = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.price !== undefined ? { price: patch.price } : {}),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: this.ctx.nowIso(),
    };
    validateProduct(next);
    return this.save(next);
  }

  setArchived(ownerId: string, id: string, archived: boolean): Product {
    const current = this.get(ownerId, id);
    return this.save({ ...current, archived, updatedAt: this.ctx.nowIso() });
  }

  private save(product: Product): Product {
    this.ctx.store.put(C.products, product);
    this.ctx.events.publish('product.updated', product.ownerId, { product });
    return product;
  }
}

function validateProduct(input: Pick<Product, 'name' | 'price'> & { readonly recurring?: Recurring | null }): void {
  const errors: FieldError[] = [];
  if (!input.name?.trim()) errors.push({ field: 'name', message: 'Name is required.' });
  if (input.price.amountMinor < 0n) errors.push({ field: 'price', message: 'Price cannot be negative.' });
  if (input.recurring) {
    if (!INTERVALS.includes(input.recurring.interval)) errors.push({ field: 'recurring.interval', message: `Use one of ${INTERVALS.join(', ')}.` });
    if (!Number.isInteger(input.recurring.intervalCount) || input.recurring.intervalCount < 1) {
      errors.push({ field: 'recurring.interval_count', message: 'Must be a positive integer.' });
    }
    if (!Number.isInteger(input.recurring.trialDays) || input.recurring.trialDays < 0) {
      errors.push({ field: 'recurring.trial_days', message: 'Must be zero or a positive integer.' });
    }
  }
  if (errors.length) throw validationFailed(errors);
}
