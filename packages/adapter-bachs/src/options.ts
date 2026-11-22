export interface BachsAdapterOptions {
  /** The platform's own account id, used as `organization_id` and `account_id`. */
  readonly organizationId?: string;
  /** After the last failed renewal retry, keep the subscription as `unpaid` instead of canceling it. */
  readonly keepUnpaidSubscriptions?: boolean;
}

export interface ResolvedBachsOptions {
  readonly organizationId: string;
  readonly keepUnpaidSubscriptions: boolean;
}

export function resolveOptions(options: BachsAdapterOptions = {}): ResolvedBachsOptions {
  return {
    organizationId: options.organizationId ?? 'acct_SandboxPlatform01',
    keepUnpaidSubscriptions: options.keepUnpaidSubscriptions ?? false,
  };
}
