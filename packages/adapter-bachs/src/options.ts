export interface BachsAdapterOptions {
  /** `organization_id` on webhook envelopes. */
  readonly organizationId?: string;
  /** After the last failed renewal retry, keep the subscription as `unpaid` instead of canceling it. */
  readonly keepUnpaidSubscriptions?: boolean;
  /** Show `completed`/`expired` checkout statuses in the API (only `open` is documented). */
  readonly exposeUndocumentedCheckoutStatuses?: boolean;
}

export interface ResolvedBachsOptions {
  readonly organizationId: string;
  readonly keepUnpaidSubscriptions: boolean;
  readonly exposeUndocumentedCheckoutStatuses: boolean;
}

export function resolveOptions(options: BachsAdapterOptions = {}): ResolvedBachsOptions {
  return {
    organizationId: options.organizationId ?? 'org_sandbox',
    keepUnpaidSubscriptions: options.keepUnpaidSubscriptions ?? false,
    exposeUndocumentedCheckoutStatuses: options.exposeUndocumentedCheckoutStatuses ?? false,
  };
}
