import { SandboxError } from '@mockrail/core';
import { BACHS } from './constants.js';

export interface BachsPagination {
  readonly next_cursor: string | null;
  readonly prev_cursor: string | null;
  readonly has_more: boolean;
  readonly limit: number;
  readonly offset: number;
  readonly returned: number;
  readonly total: number;
}

export interface BachsList<T> {
  readonly items: readonly T[];
  readonly pagination: BachsPagination;
}

interface Window {
  readonly limit: number;
  readonly offset: number;
}

/** Cursors look like `cur_<offset>` (the bad-cursor error message spells out the format). */
function decodeCursor(cursor: string): number {
  const match = /^cur_(\d+)$/.exec(cursor);
  if (!match) throw new SandboxError('bad_request', "Invalid cursor format. Expected 'cur_<offset>'.");
  return Number(match[1]);
}

/** limit is clamped to 1..100; cursor takes precedence over offset. */
export function pageWindow(query: Readonly<Record<string, string>>, defaultLimit: number = BACHS.defaultPageLimit): Window {
  const rawLimit = query.limit !== undefined && query.limit !== '' ? Number(query.limit) : defaultLimit;
  if (!Number.isFinite(rawLimit)) throw new SandboxError('validation_failed', 'limit must be an integer.', { fieldErrors: [{ field: 'limit', message: 'Must be an integer.' }] });
  const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), BACHS.maxPageLimit);
  if (query.cursor) return { limit, offset: decodeCursor(query.cursor) };
  const offset = query.offset !== undefined && query.offset !== '' ? Number(query.offset) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new SandboxError('validation_failed', 'offset must be a non-negative integer.', { fieldErrors: [{ field: 'offset', message: 'Must be 0 or more.' }] });
  return { limit, offset };
}

/** `{ items, pagination }` lists. */
export function paginate<T>(items: readonly T[], query: Readonly<Record<string, string>>, defaultLimit?: number): BachsList<T> {
  const { limit, offset } = pageWindow(query, defaultLimit);
  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return {
    items: page,
    pagination: {
      next_cursor: hasMore ? `cur_${offset + page.length}` : null,
      prev_cursor: offset > 0 ? `cur_${Math.max(0, offset - limit)}` : null,
      has_more: hasMore,
      limit,
      offset,
      returned: page.length,
      total: items.length,
    },
  };
}

/** `{ total, items }` lists (refunds, payouts). */
export function totalList<T>(items: readonly T[], query: Readonly<Record<string, string>>, defaultLimit = 50): { total: number; items: readonly T[] } {
  const { limit, offset } = pageWindow(query, defaultLimit);
  return { total: items.length, items: items.slice(offset, offset + limit) };
}

/** `{ items, total, limit, offset }` lists (webhook events). */
export function offsetList<T>(items: readonly T[], query: Readonly<Record<string, string>>, defaultLimit = 50): { items: readonly T[]; total: number; limit: number; offset: number } {
  const { limit, offset } = pageWindow(query, defaultLimit);
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset };
}
