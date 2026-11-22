/** Store collection names used by the domain modules. */
export const C = {
  customers: 'customers',
  paymentMethods: 'payment_methods',
  products: 'products',
  checkouts: 'checkout_sessions',
  charges: 'charges',
  virtualAccounts: 'virtual_accounts',
  subscriptions: 'subscriptions',
  invoices: 'invoices',
  refunds: 'refunds',
  payoutDestinations: 'payout_destinations',
  payoutQuotes: 'payout_quotes',
  payouts: 'payouts',
  accounts: 'accounts',
  persons: 'persons',
  accountDocuments: 'account_documents',
  accountLinks: 'account_links',
  transfers: 'transfers',
  platformFees: 'platform_fees',
  webhookEndpoints: 'webhook_endpoints',
  webhookEvents: 'webhook_events',
  webhookDeliveries: 'webhook_deliveries',
} as const;

export function byNewest<T extends { readonly createdAt: string }>(a: T, b: T): number {
  return b.createdAt.localeCompare(a.createdAt);
}
