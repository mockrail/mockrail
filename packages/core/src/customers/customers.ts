import type { PaymentMethod } from '../charges/charges.js';
import type { ScenarioOutcome } from '../scenarios/scenario-rule.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';

export interface Address {
  readonly line1: string | null;
  readonly line2: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly country: string | null;
}

export interface Customer {
  readonly id: string;
  readonly ownerId: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly phone: string | null;
  readonly billingAddress: Address | null;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateCustomerInput {
  readonly ownerId: string;
  readonly email?: string | null;
  readonly name?: string | null;
  readonly phone?: string | null;
  readonly billingAddress?: Address | null;
  readonly metadata?: Metadata;
}

export type UpdateCustomerInput = Partial<Omit<CreateCustomerInput, 'ownerId'>>;

/** A card (or other method) saved for off-session charges. */
export interface SavedPaymentMethod {
  readonly id: string;
  readonly ownerId: string;
  readonly customerId: string;
  readonly method: PaymentMethod;
  /** Outcome every future charge on this method gets (sandbox test cards that save, then decline). */
  readonly forcedOutcome: ScenarioOutcome | null;
  readonly isDefault: boolean;
  readonly currency: string | null;
  readonly createdAt: string;
}

export class CustomersService {
  constructor(private readonly ctx: CoreContext) {}

  create(input: CreateCustomerInput): Customer {
    if (!input.email && !input.name && !input.phone) {
      throw validationFailed([{ field: 'email', message: 'Provide at least an email, name or phone.' }]);
    }
    const now = this.ctx.nowIso();
    const customer: Customer = {
      id: this.ctx.ids.entity('customer', input.ownerId),
      ownerId: input.ownerId,
      email: input.email ?? null,
      name: input.name ?? null,
      phone: input.phone ?? null,
      billingAddress: input.billingAddress ?? null,
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.customers, customer);
    this.ctx.events.publish('customer.created', customer.ownerId, { customer });
    return customer;
  }

  findByEmail(ownerId: string, email: string): Customer | null {
    const target = email.toLowerCase();
    return this.ctx.store.list<Customer>(C.customers, (c) => c.ownerId === ownerId && c.email?.toLowerCase() === target)[0] ?? null;
  }

  /** Returns the customer with this email (applying any changes) or creates one. */
  upsertByEmail(input: CreateCustomerInput & { readonly email: string }): { customer: Customer; created: boolean } {
    const existing = this.findByEmail(input.ownerId, input.email);
    if (!existing) return { customer: this.create(input), created: true };
    const { ownerId: _o, ...patch } = input;
    return { customer: this.update(existing.ownerId, existing.id, patch), created: false };
  }

  get(ownerId: string, id: string): Customer {
    const customer = this.ctx.store.get<Customer>(C.customers, id);
    if (!customer || customer.ownerId !== ownerId) throw notFound('customer', id);
    return customer;
  }

  find(id: string | null | undefined): Customer | null {
    return id ? this.ctx.store.get<Customer>(C.customers, id) ?? null : null;
  }

  list(ownerId: string, filter: { readonly email?: string; readonly search?: string } = {}): Customer[] {
    const search = filter.search?.toLowerCase();
    return this.ctx.store
      .list<Customer>(C.customers, (c) => {
        if (c.ownerId !== ownerId) return false;
        if (filter.email && c.email !== filter.email) return false;
        if (search && !(c.email?.toLowerCase().includes(search) || c.name?.toLowerCase().includes(search))) return false;
        return true;
      })
      .sort(byNewest);
  }

  update(ownerId: string, id: string, patch: UpdateCustomerInput): Customer {
    const current = this.get(ownerId, id);
    const updated: Customer = {
      ...current,
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      ...(patch.billingAddress !== undefined ? { billingAddress: patch.billingAddress } : {}),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.customers, updated);
    this.ctx.events.publish('customer.updated', updated.ownerId, { customer: updated, previous: current });
    return updated;
  }

  // Saved payment methods

  savePaymentMethod(input: { readonly ownerId: string; readonly customerId: string; readonly method: PaymentMethod; readonly forcedOutcome?: ScenarioOutcome | null; readonly currency?: string | null }): SavedPaymentMethod {
    this.get(input.ownerId, input.customerId);
    const existing = this.listPaymentMethods(input.ownerId, input.customerId);
    if (input.method.type === 'card') {
      const fingerprint = input.method.fingerprint;
      const same = existing.find((pm) => pm.method.type === 'card' && pm.method.fingerprint === fingerprint);
      if (same) return same;
    }
    const pm: SavedPaymentMethod = {
      id: this.ctx.ids.entity('payment_method', input.ownerId),
      ownerId: input.ownerId,
      customerId: input.customerId,
      method: input.method,
      forcedOutcome: input.forcedOutcome ?? null,
      isDefault: existing.length === 0,
      currency: input.currency ?? null,
      createdAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.paymentMethods, pm);
    this.ctx.events.publish('payment_method.saved', pm.ownerId, { paymentMethod: pm });
    return pm;
  }

  listPaymentMethods(ownerId: string, customerId: string): SavedPaymentMethod[] {
    return this.ctx.store.list<SavedPaymentMethod>(C.paymentMethods, (pm) => pm.ownerId === ownerId && pm.customerId === customerId).sort(byNewest);
  }

  findPaymentMethod(id: string | null | undefined): SavedPaymentMethod | null {
    return id ? this.ctx.store.get<SavedPaymentMethod>(C.paymentMethods, id) ?? null : null;
  }

  defaultPaymentMethod(ownerId: string, customerId: string): SavedPaymentMethod | null {
    const methods = this.listPaymentMethods(ownerId, customerId);
    return methods.find((pm) => pm.isDefault) ?? methods[0] ?? null;
  }
}
