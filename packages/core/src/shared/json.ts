/** JSON helpers that round-trip bigint values (used by the SQLite store and snapshots). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
}

export function fromJson<T>(text: string): T {
  return JSON.parse(text, (_key, v: unknown) => {
    if (isBigintBox(v)) return BigInt(v.$bigint);
    return v;
  }) as T;
}

function isBigintBox(v: unknown): v is { $bigint: string } {
  if (typeof v !== 'object' || v === null) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === '$bigint';
}

export type Metadata = Readonly<Record<string, string>>;
