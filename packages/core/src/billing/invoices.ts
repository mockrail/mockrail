import type { Money } from '../money/money.js';
import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound } from '../shared/errors.js';

export type InvoiceStatus = 'open' | 'paid' | 'uncollectible' | 'void';
export type BillingReason = 'subscription_create' | 'subscription_cycle' | 'trial_end';

export interface Invoice {
  readonly id: string;
  readonly ownerId: string;
  readonly subscriptionId: string;
  readonly customerId: string | null;
  readonly amount: Money;
  readonly status: InvoiceStatus;
  readonly billingReason: BillingReason;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly attemptCount: number;
  readonly nextPaymentAttempt: string | null;
  readonly chargeId: string | null;
  readonly paidAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class InvoicesService {
  constructor(private readonly ctx: CoreContext) {}

  create(fields: Pick<Invoice, 'ownerId' | 'subscriptionId' | 'customerId' | 'amount' | 'billingReason' | 'periodStart' | 'periodEnd'>): Invoice {
    const now = this.ctx.nowIso();
    const invoice: Invoice = {
      id: this.ctx.ids.next('in'),
      ...fields,
      status: 'open',
      attemptCount: 0,
      nextPaymentAttempt: null,
      chargeId: null,
      paidAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.invoices, invoice);
    this.ctx.events.publish('invoice.created', invoice.ownerId, { invoice });
    return invoice;
  }

  save(invoice: Invoice): Invoice {
    const next = { ...invoice, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.invoices, next);
    return next;
  }

  get(ownerId: string, id: string): Invoice {
    const invoice = this.ctx.store.get<Invoice>(C.invoices, id);
    if (!invoice || invoice.ownerId !== ownerId) throw notFound('invoice', id);
    return invoice;
  }

  find(id: string | null | undefined): Invoice | null {
    return id ? this.ctx.store.get<Invoice>(C.invoices, id) ?? null : null;
  }

  list(ownerId: string, filter: { readonly subscriptionId?: string } = {}): Invoice[] {
    return this.ctx.store
      .list<Invoice>(C.invoices, (i) => i.ownerId === ownerId && (!filter.subscriptionId || i.subscriptionId === filter.subscriptionId))
      .sort(byNewest);
  }
}
