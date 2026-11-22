import type { AdapterRequest, AdapterResponse, CurrencyCode, HttpMethod, Money, RouteDefinition } from '@mockrail/core';
import { isPlatformOwner, platformOf } from '@mockrail/core';
import { bachsError } from '../errors.js';
import type { ResolvedBachsOptions } from '../options.js';
import { offsetList, paginate, totalList } from '../pagination.js';
import type { BodyReader } from '../request.js';
import type { View } from '../view.js';

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
export const noContent = (): AdapterResponse => ({ status: 204 });

export function viewOf(req: AdapterRequest, options: ResolvedBachsOptions): View {
  return { sandbox: req.sandbox, options };
}

export function platformOwnerOf(req: AdapterRequest): string {
  return platformOf(req.ownerId);
}

/** `{ items, pagination }` list. */
export function list<T, R>(req: AdapterRequest, items: readonly T[], serialize: (item: T) => R, defaultLimit?: number): AdapterResponse {
  const page = paginate(items, req.query, defaultLimit);
  return ok({ items: page.items.map(serialize), pagination: page.pagination });
}

/** `{ total, items }` list. */
export function listWithTotal<T, R>(req: AdapterRequest, items: readonly T[], serialize: (item: T) => R): AdapterResponse {
  const page = totalList(items, req.query);
  return ok({ total: page.total, items: page.items.map(serialize) });
}

/** `{ items, total, limit, offset }` list. */
export function listWithOffset<T, R>(req: AdapterRequest, items: readonly T[], serialize: (item: T) => R): AdapterResponse {
  const page = offsetList(items, req.query);
  return ok({ items: page.items.map(serialize), total: page.total, limit: page.limit, offset: page.offset });
}

export interface TransferFields {
  readonly platformFee: Money | null;
  readonly transferDestination: string | null;
  readonly transferAmount: Money | null;
}

/**
 * Split payments (Direct and Destination charges guides):
 * - With X-Account-Id (direct charge): platform_fee allowed, transfer_data is CONTRADICTORY_CHARGE_TYPE.
 * - As the platform with transfer_data (destination charge): exactly one of platform_fee or
 *   transfer_data.amount; neither is INVALID_PLATFORM_FEE.
 */
export function readTransferFields(body: BodyReader, req: AdapterRequest, currency: CurrencyCode | undefined): TransferFields {
  const platformFee = body.amount('platform_fee', currency, { allowZero: true }) ?? null;
  const transferData = body.object('transfer_data');
  const transferDestination = transferData?.string('destination', { required: true }) ?? null;
  const transferAmount = transferData?.amount('amount', currency) ?? null;
  body.done();
  const acting = !isPlatformOwner(req.ownerId);
  if (transferDestination && acting) {
    throw bachsError('CONTRADICTORY_CHARGE_TYPE', 400, 'transfer_data cannot be combined with X-Account-Id. Use one charge type.');
  }
  if (transferDestination) {
    if (platformFee && transferAmount) throw bachsError('VALIDATION_ERROR', 400, 'Send exactly one of platform_fee or transfer_data.amount.', { field: 'platform_fee' });
    if (!platformFee && !transferAmount) throw bachsError('INVALID_PLATFORM_FEE', 400, 'A destination charge needs platform_fee or transfer_data.amount.', { field: 'platform_fee' });
  }
  if (platformFee && !transferDestination && !acting) {
    throw bachsError('INVALID_PLATFORM_FEE', 400, 'platform_fee needs a connected account (X-Account-Id or transfer_data).', { field: 'platform_fee' });
  }
  return { platformFee, transferDestination, transferAmount };
}

/** Metadata limits: up to 20 keys. */
export function checkMetadata(metadata: Record<string, string> | undefined, maxKeys = 20): void {
  if (metadata && Object.keys(metadata).length > maxKeys) {
    throw bachsError('METADATA_LIMIT_EXCEEDED', 400, `Metadata can have at most ${maxKeys} keys.`, { field: 'metadata' });
  }
}
