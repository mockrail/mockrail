export interface CompiledRoute<T> {
  readonly method: string;
  readonly segments: readonly string[];
  readonly value: T;
}

export interface RouteMatch<T> {
  readonly value: T;
  readonly params: Record<string, string>;
}

/** Minimal path router: `:name` segments capture; static segments beat params when both match. */
export class Router<T> {
  private readonly routes: CompiledRoute<T>[] = [];

  add(method: string, path: string, value: T): void {
    this.routes.push({ method: method.toUpperCase(), segments: split(path), value });
  }

  match(method: string, path: string): RouteMatch<T> | 'method_not_allowed' | undefined {
    const parts = split(path);
    let best: { route: CompiledRoute<T>; params: Record<string, string>; score: number } | undefined;
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      pathMatched = true;
      if (route.method !== method.toUpperCase()) continue;
      const score = route.segments.reduce((s, seg, i) => s + (seg.startsWith(':') ? 0 : 2 ** (route.segments.length - i)), 0);
      if (!best || score > best.score) best = { route, params, score };
    }
    if (best) return { value: best.route.value, params: best.params };
    return pathMatched ? 'method_not_allowed' : undefined;
  }
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

function matchSegments(pattern: readonly string[], parts: readonly string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const seg = pattern[i] as string;
    const part = parts[i] as string;
    if (seg.startsWith(':')) {
      try {
        params[seg.slice(1)] = decodeURIComponent(part);
      } catch {
        return null;
      }
    } else if (seg !== part) {
      return null;
    }
  }
  return params;
}
