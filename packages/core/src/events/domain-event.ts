export type DomainEventType =
  | 'customer.created'
  | 'customer.updated'
  | 'product.created'
  | 'product.updated'
  | 'checkout.created'
  | 'checkout.completed'
  | 'checkout.expired'
  | 'charge.created'
  | 'charge.succeeded'
  | 'charge.underpaid'
  | 'charge.failed'
  | 'charge.refunded'
  | 'charge.settled'
  | 'virtual_account.created'
  | 'deposit.held'
  | 'deposit.released'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.canceled'
  | 'invoice.created'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'refund.created'
  | 'refund.succeeded'
  | 'refund.failed'
  | 'payout.created'
  | 'payout.processing'
  | 'payout.completed'
  | 'payout.failed'
  | 'account.created'
  | 'account.updated'
  | 'account.tasks_requested'
  | 'capability.updated'
  | 'transfer.created'
  | 'platform_fee.created';

export interface DomainEvent<T = Record<string, unknown>> {
  readonly id: string;
  readonly type: DomainEventType;
  readonly occurredAt: string;
  /** Owner whose resource changed: the platform or a connected account id. */
  readonly ownerId: string;
  readonly sequence: number;
  readonly data: T;
}
