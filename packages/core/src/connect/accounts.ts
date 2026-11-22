import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { ownerId, providerOf } from '../shared/owners.js';

export type CapabilityStatus = 'active' | 'pending' | 'restricted' | 'inactive' | 'unrequested' | 'unsupported';

export interface Capability {
  readonly status: CapabilityStatus;
  readonly requested: boolean;
  readonly international?: boolean;
}

export interface ConnectedAccount {
  readonly id: string;
  /** Owner string of the platform that created the account. */
  readonly platformOwnerId: string;
  readonly email: string | null;
  readonly country: string | null;
  readonly displayName: string | null;
  readonly capabilities: Readonly<Record<string, Capability>>;
  readonly requirementsDue: readonly string[];
  /** Provider-specific profile fields, owned by the adapter (dashboard mode, entity type, ...). */
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Person {
  readonly id: string;
  readonly accountId: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountDocument {
  readonly id: string;
  readonly accountId: string;
  readonly personId: string | null;
  readonly slot: string;
  readonly fileId: string | null;
  readonly fileName: string | null;
  readonly createdAt: string;
}

export interface AccountLink {
  readonly id: string;
  readonly kind: string;
  readonly accountId: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly supersededPrevious: boolean;
}

export interface CreateAccountInput {
  readonly platformOwnerId: string;
  readonly email?: string | null;
  readonly country?: string | null;
  readonly displayName?: string | null;
  /** Final capability map, already decided by the adapter (sandboxes may over-grant). */
  readonly capabilities: Readonly<Record<string, Capability>>;
  readonly requirementsDue?: readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly metadata?: Metadata;
}

export interface UpdateAccountInput {
  readonly email?: string | null;
  readonly country?: string | null;
  readonly displayName?: string | null;
  readonly requirementsDue?: readonly string[];
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly metadata?: Metadata;
}

export interface PersonInput {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export class AccountsService {
  constructor(private readonly ctx: CoreContext) {}

  create(input: CreateAccountInput): ConnectedAccount {
    const now = this.ctx.nowIso();
    const account: ConnectedAccount = {
      id: this.ctx.ids.entity('account', input.platformOwnerId),
      platformOwnerId: input.platformOwnerId,
      email: input.email ?? null,
      country: input.country ?? null,
      displayName: input.displayName ?? null,
      capabilities: input.capabilities,
      requirementsDue: input.requirementsDue ?? [],
      attributes: input.attributes ?? {},
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.accounts, account);
    const owner = this.ownerOf(account);
    this.ctx.events.publish('account.created', owner, { account });
    for (const [capability, value] of Object.entries(account.capabilities)) {
      this.ctx.events.publish('capability.updated', owner, { account, capability, ...value, previousStatus: null });
    }
    if (account.requirementsDue.length) {
      this.ctx.events.publish('account.tasks_requested', owner, { account, tasks: account.requirementsDue });
    }
    return account;
  }

  /** Owner string for resources owned by this account. */
  ownerOf(account: Pick<ConnectedAccount, 'id' | 'platformOwnerId'>): string {
    return ownerId(providerOf(account.platformOwnerId), account.id);
  }

  /** Account belonging to this platform, or a not-found error. */
  get(platformOwnerId: string, id: string): ConnectedAccount {
    const account = this.ctx.store.get<ConnectedAccount>(C.accounts, id);
    if (!account || account.platformOwnerId !== platformOwnerId) throw notFound('account', id);
    return account;
  }

  find(id: string | null | undefined): ConnectedAccount | null {
    return id ? this.ctx.store.get<ConnectedAccount>(C.accounts, id) ?? null : null;
  }

  list(platformOwnerId: string): ConnectedAccount[] {
    return this.ctx.store.list<ConnectedAccount>(C.accounts, (a) => a.platformOwnerId === platformOwnerId).sort(byNewest);
  }

  update(platformOwnerId: string, id: string, patch: UpdateAccountInput): ConnectedAccount {
    const current = this.get(platformOwnerId, id);
    const next: ConnectedAccount = {
      ...current,
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.country !== undefined ? { country: patch.country } : {}),
      ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
      ...(patch.requirementsDue !== undefined ? { requirementsDue: patch.requirementsDue } : {}),
      attributes: patch.attributes ? { ...current.attributes, ...patch.attributes } : current.attributes,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.accounts, next);
    this.ctx.events.publish('account.updated', this.ownerOf(next), { account: next, previous: current });
    if (next.requirementsDue.some((r) => !current.requirementsDue.includes(r))) {
      this.ctx.events.publish('account.tasks_requested', this.ownerOf(next), { account: next, tasks: next.requirementsDue.filter((r) => !current.requirementsDue.includes(r)) });
    }
    return next;
  }

  setCapability(platformOwnerId: string, id: string, capability: string, value: Capability): ConnectedAccount {
    const current = this.get(platformOwnerId, id);
    const previous = current.capabilities[capability];
    if (previous && previous.status === value.status && previous.requested === value.requested && previous.international === value.international) return current;
    const next: ConnectedAccount = { ...current, capabilities: { ...current.capabilities, [capability]: value }, updatedAt: this.ctx.nowIso() };
    this.ctx.store.put(C.accounts, next);
    this.ctx.events.publish('capability.updated', this.ownerOf(next), { account: next, capability, ...value, previousStatus: previous?.status ?? null });
    return next;
  }

  createLink(platformOwnerId: string, accountId: string, kind: string, ttlMs: number): AccountLink {
    this.get(platformOwnerId, accountId);
    const now = this.ctx.now();
    const previous = this.ctx.store.list<AccountLink>(C.accountLinks, (l) => l.accountId === accountId && l.kind === kind);
    for (const link of previous) this.ctx.store.delete(C.accountLinks, link.id);
    const link: AccountLink = {
      id: this.ctx.ids.entity('account_link', platformOwnerId),
      kind,
      accountId,
      url: `${this.ctx.config.publicBaseUrl}/__sandbox/connect/${kind}/${accountId}?token=${this.ctx.ids.secret('')}`,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      createdAt: now.toISOString(),
      supersededPrevious: previous.length > 0,
    };
    this.ctx.store.put(C.accountLinks, link);
    return link;
  }

  // Persons

  addPerson(platformOwnerId: string, accountId: string, input: PersonInput): Person {
    this.get(platformOwnerId, accountId);
    const now = this.ctx.nowIso();
    const person: Person = {
      id: this.ctx.ids.entity('person', platformOwnerId),
      accountId,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      attributes: input.attributes ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.persons, person);
    return person;
  }

  getPerson(platformOwnerId: string, accountId: string, personId: string): Person {
    this.get(platformOwnerId, accountId);
    const person = this.ctx.store.get<Person>(C.persons, personId);
    if (!person || person.accountId !== accountId) throw notFound('person', personId);
    return person;
  }

  listPersons(platformOwnerId: string, accountId: string): Person[] {
    this.get(platformOwnerId, accountId);
    return this.ctx.store.list<Person>(C.persons, (p) => p.accountId === accountId).sort(byNewest);
  }

  updatePerson(platformOwnerId: string, accountId: string, personId: string, patch: PersonInput): Person {
    const current = this.getPerson(platformOwnerId, accountId, personId);
    const next: Person = {
      ...current,
      ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
      ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
      ...(patch.email !== undefined ? { email: patch.email } : {}),
      ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
      attributes: patch.attributes ? { ...current.attributes, ...patch.attributes } : current.attributes,
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.persons, next);
    return next;
  }

  removePerson(platformOwnerId: string, accountId: string, personId: string): Person {
    const person = this.getPerson(platformOwnerId, accountId, personId);
    this.ctx.store.delete(C.persons, personId);
    return person;
  }

  // Documents

  addDocument(platformOwnerId: string, accountId: string, input: { readonly slot: string; readonly fileId?: string | null; readonly fileName?: string | null; readonly personId?: string | null }): AccountDocument {
    this.get(platformOwnerId, accountId);
    if (!input.slot) throw validationFailed([{ field: 'document', message: 'The document slot is required.' }]);
    if (input.personId) this.getPerson(platformOwnerId, accountId, input.personId);
    const document: AccountDocument = {
      id: this.ctx.ids.entity('document', platformOwnerId),
      accountId,
      personId: input.personId ?? null,
      slot: input.slot,
      fileId: input.fileId ?? null,
      fileName: input.fileName ?? null,
      createdAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.accountDocuments, document);
    return document;
  }

  listDocuments(accountId: string, personId?: string): AccountDocument[] {
    return this.ctx.store
      .list<AccountDocument>(C.accountDocuments, (d) => d.accountId === accountId && (personId === undefined || d.personId === personId))
      .sort(byNewest);
  }
}
