/**
 * Owners are provider-scoped tenants: `<providerId>:platform` for the organization holding the API
 * key, or `<providerId>:<accountId>` for a connected account. Scoping by provider keeps two
 * adapters' data, balances and webhooks fully separate, as two real provider accounts would be.
 */
export type OwnerId = string;

export const PLATFORM = 'platform';

export function ownerId(providerId: string, local: string): OwnerId {
  return `${providerId}:${local}`;
}

export function platformOwner(providerId: string): OwnerId {
  return ownerId(providerId, PLATFORM);
}

export function parseOwner(owner: OwnerId): { readonly providerId: string; readonly local: string } {
  const i = owner.indexOf(':');
  return i < 0 ? { providerId: '', local: owner } : { providerId: owner.slice(0, i), local: owner.slice(i + 1) };
}

export function providerOf(owner: OwnerId): string {
  return parseOwner(owner).providerId;
}

export function localOf(owner: OwnerId): string {
  return parseOwner(owner).local;
}

export function isPlatformOwner(owner: OwnerId): boolean {
  return localOf(owner) === PLATFORM;
}

/** The platform owner of the same provider. */
export function platformOf(owner: OwnerId): OwnerId {
  return platformOwner(providerOf(owner));
}
