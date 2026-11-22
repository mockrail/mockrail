import type { AdapterRequest, AdapterResponse, CurrencyCode, HttpMethod, Money, RouteDefinition } from '@mockrail/core';
import { PLATFORM_OWNER, validationFailed } from '@mockrail/core';
import type { ResolvedBachsOptions } from '../options.js';
import { paginate } from '../pagination.js';
import type { BodyReader } from '../request.js';

export type RouteFactory = (options: ResolvedBachsOptions) => RouteDefinition[];

export function route(
  method: HttpMethod,
  path: string,
  operation: string,
  handler: (request: AdapterRequest) => AdapterResponse | Promise<AdapterResponse>,
): RouteDefinition {
  return { method, path, operation, handler };
}

export const ok = (body: unknown): AdapterResponse => ({ status: 200, body });
export const created = (body: unknown): AdapterResponse => ({ status: 201, body });

export function list<T, R>(request: AdapterRequest, items: readonly T[], serialize: (item: T) => R): AdapterResponse {
  const page = paginate(items, request.query);
  return ok({ items: page.items.map(serialize), pagination: page.pagination });
}

export interface TransferFields {
  readonly platformFee: Money | null;
  readonly transferDestination: string | null;
  readonly transferAmount: Money | null;
}

/**
 * Split payment fields. A destination charge (platform charge naming an account in
 * transfer_data.destination) needs exactly one of platform_fee or transfer_data.amount.
 * A direct charge (made as the account via X-Account-Id) may carry platform_fee.
 */
export function readTransferFields(body: BodyReader, request: AdapterRequest, currency: CurrencyCode | undefined): TransferFields {
  const platformFee = body.amount('platform_fee', currency, { allowZero: true }) ?? null;
  const transferData = body.object('transfer_data');
  const transferDestination = transferData?.string('destination', { required: true }) ?? null;
  const transferAmount = transferData?.amount('amount', currency) ?? null;
  body.done();

  if (transferDestination) {
    if (request.ownerId !== PLATFORM_OWNER) {
      throw validationFailed([{ field: 'transfer_data', message: 'Destination charges are created by the platform, not while acting as an account.' }]);
    }
    if ((platformFee === null) === (transferAmount === null)) {
      throw validationFailed([{ field: 'platform_fee', message: 'Provide exactly one of platform_fee or transfer_data.amount for a destination charge.' }]);
    }
  }
  return { platformFee, transferDestination, transferAmount };
}
