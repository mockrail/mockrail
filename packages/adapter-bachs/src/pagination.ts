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

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string): number {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    if (typeof parsed.o === 'number' && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed.o;
  } catch {
    // fall through
  }
  throw new SandboxError('bad_request', 'The cursor is invalid or has expired.');
}

/**
 * Bachs pagination: `limit` defaults to 20 and is clamped to 100; `cursor` takes precedence over `offset`;
 * a bad cursor is 400 BAD_REQUEST.
 */
export function paginate<T>(items: readonly T[], query: Readonly<Record<string, string>>): BachsList<T> {
  const rawLimit = query.limit !== undefined ? Number(query.limit) : BACHS.defaultPageLimit;
  if (!Number.isFinite(rawLimit)) throw new SandboxError('bad_request', 'limit must be a number.');
  const limit = Math.min(Math.max(Math.trunc(rawLimit), 1), BACHS.maxPageLimit);

  let offset: number;
  if (query.cursor) offset = decodeCursor(query.cursor);
  else {
    offset = query.offset !== undefined ? Number(query.offset) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new SandboxError('bad_request', 'offset must be a non-negative integer.');
  }

  const page = items.slice(offset, offset + limit);
  const hasMore = offset + page.length < items.length;
  return {
    items: page,
    pagination: {
      next_cursor: hasMore ? encodeCursor(offset + page.length) : null,
      prev_cursor: offset > 0 ? encodeCursor(Math.max(0, offset - limit)) : null,
      has_more: hasMore,
      limit,
      offset,
      returned: page.length,
      total: items.length,
    },
  };
}
