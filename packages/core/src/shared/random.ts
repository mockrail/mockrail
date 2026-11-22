import { randomBytes } from 'node:crypto';

export interface Random {
  /** Uniform float in [0, 1). */
  next(): number;
  int(maxExclusive: number): number;
}

/** Seeded PRNG (mulberry32) so chaos and IDs are reproducible in CI. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (max) => Math.floor(next() * max) };
}

export function cryptoRandom(): Random {
  const next = (): number => randomBytes(4).readUInt32BE(0) / 4294967296;
  return { next, int: (max) => Math.floor(next() * max) };
}
