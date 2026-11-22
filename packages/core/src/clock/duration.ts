const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Parses human durations such as "30d", "+30 days", "1h30m", "500ms" or a bare number of milliseconds.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`Invalid duration: ${input}`);
    return input;
  }
  const text = input.trim().replace(/^\+/, '').toLowerCase();
  if (/^\d+$/.test(text)) return Number(text);
  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let consumed = '';
  for (const match of text.matchAll(pattern)) {
    const [whole, amount, unit] = match;
    const factor = unit ? UNIT_MS[unit] : undefined;
    if (factor === undefined || amount === undefined) throw new Error(`Unknown duration unit in '${input}'`);
    total += Number(amount) * factor;
    consumed += whole;
  }
  if (consumed.replace(/\s/g, '') !== text.replace(/\s/g, '') || total === 0 && consumed === '') {
    throw new Error(`Invalid duration: '${input}'`);
  }
  return Math.round(total);
}
