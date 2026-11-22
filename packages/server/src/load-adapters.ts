import type { ProviderAdapter } from '@mockrail/core';

export type ProviderSpec = string | ProviderAdapter;

function isAdapter(value: unknown): value is ProviderAdapter {
  return !!value && typeof value === 'object' && typeof (value as ProviderAdapter).providerId === 'string' && Array.isArray((value as ProviderAdapter).routes);
}

/**
 * Loads adapters named in config. "bachs" resolves to @mockrail/adapter-bachs; any other name is
 * tried as @mockrail/adapter-<name> and then as a package name, so third parties can publish their
 * own adapter. Only adapters listed are imported, so slim images can ship just those packages.
 */
export async function loadAdapters(specs: readonly ProviderSpec[]): Promise<Map<string, ProviderAdapter>> {
  const adapters = new Map<string, ProviderAdapter>();
  for (const spec of specs) {
    const adapter = typeof spec === 'string' ? await importAdapter(spec) : spec;
    if (adapters.has(adapter.providerId)) throw new Error(`Provider '${adapter.providerId}' is loaded twice`);
    adapters.set(adapter.providerId, adapter);
  }
  if (adapters.size === 0) throw new Error('No providers configured. Add at least one, e.g. providers: ["bachs"].');
  return adapters;
}

async function importAdapter(name: string): Promise<ProviderAdapter> {
  const candidates = name.includes('/') || name.startsWith('.') ? [name] : [`@mockrail/adapter-${name}`, name];
  const errors: string[] = [];
  for (const specifier of candidates) {
    try {
      const mod = (await import(specifier)) as Record<string, unknown>;
      const found = [mod.default, mod.adapter, typeof mod.createAdapter === 'function' ? (mod.createAdapter as () => unknown)() : undefined].find(isAdapter);
      if (found) return found;
      errors.push(`${specifier}: no adapter export (expected default, "adapter" or "createAdapter")`);
    } catch (error) {
      errors.push(`${specifier}: ${(error as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`Could not load provider '${name}'.\n  ${errors.join('\n  ')}`);
}
