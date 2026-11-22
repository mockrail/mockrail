import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export interface Customer {
  readonly id: string;
  readonly ownerId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCustomerInput {
  readonly ownerId: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly metadata?: Metadata;
}

export type UpdateCustomerInput = Partial<Omit<CreateCustomerInput, 'ownerId'>>;

export class CustomersService {
  constructor(private readonly ctx: CoreContext) {}

  create(input: CreateCustomerInput): Customer {
    if (!input.email && !input.name && !input.phone) {
      throw validationFailed([{ field: 'email', message: 'Provide at least an email, name or phone.' }]);
    }
    const now = this.ctx.nowIso();
    const customer: Customer = {
      id: this.ctx.ids.next('cus'),
      ownerId: input.ownerId,
      email: input.email ?? null,
      name: input.name ?? null,
      phone: input.phone ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.customers, customer);
    this.ctx.events.publish('customer.created', customer.ownerId, { customer });
    return customer;
  }

  /** Finds a customer by email or creates one (used by checkout). */
  findOrCreate(input: CreateCustomerInput): Customer {
    if (input.email) {
      const existing = this.ctx.store.list<Customer>(C.customers, (c) => c.ownerId === input.ownerId && c.email === input.email)[0];
      if (existing) return existing;
    }
    return this.create(input);
  }

  get(ownerId: string, id: string): Customer {
    const customer = this.ctx.store.get<Customer>(C.customers, id);
    if (!customer || customer.ownerId !== ownerId) throw notFound('customer', id);
    return customer;
  }

  find(id: string | null | undefined): Customer | null {
    return id ? this.ctx.store.get<Customer>(C.customers, id) ?? null : null;
  }

  list(ownerId: string, filter: { readonly email?: string } = {}): Customer[] {
    return this.ctx.store
      .list<Customer>(C.customers, (c) => c.ownerId === ownerId && (!filter.email || c.email === filter.email))
      .sort(byNewest);
  }

  update(ownerId: string, id: string, patch: UpdateCustomerInput): Customer {
    const current = this.get(ownerId, id);
    const updated: Customer = {
      ...current,
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.customers, updated);
    this.ctx.events.publish('customer.updated', updated.ownerId, { customer: updated });
    return updated;
  }
}
