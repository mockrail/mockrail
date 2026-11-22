import type { Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, SandboxError, validationFailed, type FieldError } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export type RecurringInterval = 'day' | 'week' | 'month' | 'year';

export interface Cadence {
  readonly interval: RecurringInterval;
  readonly intervalCount: number;
}

export interface Recurring extends Cadence {
  /** Free trial before the first charge; null for none. */
  readonly trial: Cadence | null;
}

export type PriceType = 'fixed' | 'free' | 'custom';

export interface CustomPriceBounds {
  readonly preset: Money | null;
  readonly minimum: Money | null;
  readonly maximum: Money | null;
}

export interface Product {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceType: PriceType;
  /** Fixed price; zero for free and custom prices. */
  readonly price: Money;
  readonly customBounds: CustomPriceBounds | null;
  /** Alternative fixed prices in other currencies. */
  readonly currencyOptions: readonly Money[];
  readonly recurring: Recurring | null;
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateProductInput {
  readonly ownerId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly priceType?: PriceType;
  readonly price: Money;
  readonly customBounds?: CustomPriceBounds | null;
  readonly currencyOptions?: readonly Money[];
  readonly recurring?: Recurring | null;
  readonly metadata?: Metadata;
}

export interface UpdateProductInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly price?: Money;
  readonly currencyOptions?: readonly Money[];
  readonly recurring?: Recurring | null;
  readonly metadata?: Metadata;
}

const INTERVALS: readonly RecurringInterval[] = ['day', 'week', 'month', 'year'];

export class ProductsService {
  constructor(private readonly ctx: CoreContext) {}

  create(input: CreateProductInput): Product {
    const now = this.ctx.nowIso();
    const product: Product = {
      id: this.ctx.ids.entity('product', input.ownerId),
      ownerId: input.ownerId,
      name: input.name,
      description: input.description ?? null,
      priceType: input.priceType ?? 'fixed',
      price: input.price,
      customBounds: input.customBounds ?? null,
      currencyOptions: input.currencyOptions ?? [],
      recurring: input.recurring ?? null,
      archived: false,
      archivedAt: null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    validateProduct(product);
    this.ctx.store.put(C.products, product);
    this.ctx.events.publish('product.created', product.ownerId, { product });
    return product;
  }

  get(ownerId: string, id: string): Product {
    const product = this.ctx.store.get<Product>(C.products, id);
    if (!product || product.ownerId !== ownerId) throw notFound('product', id);
    return product;
  }

  find(id: string | null | undefined): Product | null {
    return id ? this.ctx.store.get<Product>(C.products, id) ?? null : null;
  }

  list(ownerId: string, filter: { readonly includeArchived?: boolean } = {}): Product[] {
    return this.ctx.store
      .list<Product>(C.products, (p) => p.ownerId === ownerId && (filter.includeArchived || !p.archived))
      .sort(byNewest);
  }

  update(ownerId: string, id: string, patch: UpdateProductInput): Product {
    const current = this.get(ownerId, id);
    if (patch.recurring !== undefined && current.recurring && patch.recurring && (patch.recurring.interval !== current.recurring.interval || patch.recurring.intervalCount !== current.recurring.intervalCount)) {
      throw new SandboxError('validation_failed', 'The billing cycle cannot change once set. Create a new product instead.', { details: { reason: 'recurring_interval_immutable' } });
    }
    const next: Product = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.price !== undefined ? { price: patch.price } : {}),
      ...(patch.currencyOptions !== undefined ? { currencyOptions: patch.currencyOptions } : {}),
      ...(patch.recurring !== undefined ? { recurring: patch.recurring } : {}),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: this.ctx.nowIso(),
    };
    validateProduct(next);
    return this.save(next);
  }

  setArchived(ownerId: string, id: string, archived: boolean): Product {
    const current = this.get(ownerId, id);
    const now = this.ctx.nowIso();
    return this.save({ ...current, archived, archivedAt: archived ? now : null, updatedAt: now });
  }

  /** Price for a currency: the primary price or a currency option. */
  priceIn(product: Product, currency: string): Money | null {
    if (product.price.currency === currency) return product.price;
    return product.currencyOptions.find((o) => o.currency === currency) ?? null;
  }

  private save(product: Product): Product {
    this.ctx.store.put(C.products, product);
    this.ctx.events.publish('product.updated', product.ownerId, { product });
    return product;
  }
}

function validateProduct(p: Product): void {
  const errors: FieldError[] = [];
  if (!p.name?.trim()) errors.push({ field: 'name', message: 'Name is required.' });
  if (p.price.amountMinor < 0n) errors.push({ field: 'price.amount', message: 'Price cannot be negative.' });
  if (p.currencyOptions.some((o) => o.currency === p.price.currency)) errors.push({ field: 'price.currency_options', message: 'The primary currency cannot repeat in currency_options.' });
  const cadence = (c: Cadence, field: string): void => {
    if (!INTERVALS.includes(c.interval)) errors.push({ field: `${field}.interval`, message: `Use one of ${INTERVALS.join(', ')}.` });
    if (!Number.isInteger(c.intervalCount) || c.intervalCount < 1) errors.push({ field: `${field}.frequency`, message: 'Must be a positive integer.' });
  };
  if (p.recurring) {
    cadence(p.recurring, 'billing_cycle');
    if (p.recurring.trial) cadence(p.recurring.trial, 'trial_period');
  }
  if (errors.length) throw validationFailed(errors);
}
