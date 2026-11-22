import { byNewest, C } from '../shared/collections.js';
import type { CoreContext } from '../shared/context.js';
import { notFound, validationFailed } from '../shared/errors.js';
import type { Metadata } from '../shared/json.js';
import { PLATFORM_OWNER } from '../shared/owners.js';

export type CapabilityStatus = 'active' | 'inactive' | 'pending';

export interface ConnectedAccount {
  readonly id: string;
  readonly type: string;
  readonly email: string | null;
  readonly country: string | null;
  readonly businessName: string | null;
  readonly businessType: string | null;
  readonly defaultCurrency: string | null;
  readonly capabilities: Readonly<Record<string, CapabilityStatus>>;
  readonly requirementsDue: readonly string[];
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
  readonly roles: readonly string[];
  readonly metadata: Metadata;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AccountDocument {
  readonly id: string;
  readonly accountId: string;
  readonly personId: string | null;
  readonly purpose: string;
  readonly fileName: string | null;
  readonly createdAt: string;
}

export interface AccountLink {
  readonly kind: 'onboarding' | 'login' | 'dashboard_invite';
  readonly accountId: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface CreateAccountInput {
  readonly type?: string;
  readonly email?: string | null;
  readonly country?: string | null;
  readonly businessName?: string | null;
  readonly businessType?: string | null;
  readonly defaultCurrency?: string | null;
  /** Final capability map, already decided by the adapter (sandboxes may over-grant). */
  readonly capabilities: Readonly<Record<string, CapabilityStatus>>;
  readonly requirementsDue?: readonly string[];
  readonly metadata?: Metadata;
}

export type UpdateAccountInput = Partial<Omit<CreateAccountInput, 'capabilities'>>;

export interface PersonInput {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly roles?: readonly string[];
  readonly metadata?: Metadata;
}

export class AccountsService {
  constructor(private readonly ctx: CoreContext) {}

  create(input: CreateAccountInput): ConnectedAccount {
    const now = this.ctx.nowIso();
    const account: ConnectedAccount = {
      id: this.ctx.ids.next('acct'),
      type: input.type ?? 'standard',
      email: input.email ?? null,
      country: input.country ?? null,
      businessName: input.businessName ?? null,
      businessType: input.businessType ?? null,
      defaultCurrency: input.defaultCurrency ?? null,
      capabilities: input.capabilities,
      requirementsDue: input.requirementsDue ?? [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.accounts, account);
    this.ctx.events.publish('account.created', account.id, { account });
    for (const [capability, status] of Object.entries(account.capabilities)) {
      this.ctx.events.publish('capability.updated', account.id, { account, capability, status, previousStatus: null });
    }
    if (account.requirementsDue.length) {
      this.ctx.events.publish('account.tasks_requested', account.id, { account, tasks: account.requirementsDue });
    }
    return account;
  }

  get(id: string): ConnectedAccount {
    const account = this.ctx.store.get<ConnectedAccount>(C.accounts, id);
    if (!account) throw notFound('account', id);
    return account;
  }

  find(id: string | null | undefined): ConnectedAccount | null {
    return id ? this.ctx.store.get<ConnectedAccount>(C.accounts, id) ?? null : null;
  }

  exists(id: string): boolean {
    return id === PLATFORM_OWNER || this.find(id) !== null;
  }

  list(): ConnectedAccount[] {
    return this.ctx.store.list<ConnectedAccount>(C.accounts).sort(byNewest);
  }

  update(id: string, patch: UpdateAccountInput): ConnectedAccount {
    const current = this.get(id);
    const next: ConnectedAccount = {
      ...current,
      ...definedOnly({
        type: patch.type,
        email: patch.email,
        country: patch.country,
        businessName: patch.businessName,
        businessType: patch.businessType,
        defaultCurrency: patch.defaultCurrency,
        requirementsDue: patch.requirementsDue,
      }),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.accounts, next);
    this.ctx.events.publish('account.updated', next.id, { account: next, previous: current });
    return next;
  }

  setCapability(id: string, capability: string, status: CapabilityStatus): ConnectedAccount {
    const current = this.get(id);
    const previousStatus = current.capabilities[capability] ?? null;
    if (previousStatus === status) return current;
    const next: ConnectedAccount = {
      ...current,
      capabilities: { ...current.capabilities, [capability]: status },
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.accounts, next);
    this.ctx.events.publish('capability.updated', next.id, { account: next, capability, status, previousStatus });
    this.ctx.events.publish('account.updated', next.id, { account: next, previous: current });
    return next;
  }

  createLink(accountId: string, kind: AccountLink['kind'], ttlMs: number): AccountLink {
    this.get(accountId);
    const now = this.ctx.now();
    const token = this.ctx.ids.secret('');
    return {
      kind,
      accountId,
      url: `${this.ctx.config.publicBaseUrl}/__sandbox/connect/${kind}/${accountId}?token=${token}`,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      createdAt: now.toISOString(),
    };
  }

  // Persons

  addPerson(accountId: string, input: PersonInput): Person {
    this.get(accountId);
    const now = this.ctx.nowIso();
    const person: Person = {
      id: this.ctx.ids.next('person'),
      accountId,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      roles: input.roles ?? [],
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.ctx.store.put(C.persons, person);
    return person;
  }

  getPerson(accountId: string, personId: string): Person {
    const person = this.ctx.store.get<Person>(C.persons, personId);
    if (!person || person.accountId !== accountId) throw notFound('person', personId);
    return person;
  }

  listPersons(accountId: string): Person[] {
    this.get(accountId);
    return this.ctx.store.list<Person>(C.persons, (p) => p.accountId === accountId).sort(byNewest);
  }

  updatePerson(accountId: string, personId: string, patch: PersonInput): Person {
    const current = this.getPerson(accountId, personId);
    const next: Person = {
      ...current,
      ...definedOnly({ firstName: patch.firstName, lastName: patch.lastName, email: patch.email, phone: patch.phone, roles: patch.roles }),
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: this.ctx.nowIso(),
    };
    this.ctx.store.put(C.persons, next);
    return next;
  }

  removePerson(accountId: string, personId: string): Person {
    const person = this.getPerson(accountId, personId);
    this.ctx.store.delete(C.persons, personId);
    return person;
  }

  // Documents

  addDocument(accountId: string, input: { readonly purpose: string; readonly fileName?: string | null; readonly personId?: string | null }): AccountDocument {
    this.get(accountId);
    if (!input.purpose) throw validationFailed([{ field: 'purpose', message: 'Purpose is required.' }]);
    if (input.personId) this.getPerson(accountId, input.personId);
    const document: AccountDocument = {
      id: this.ctx.ids.next('doc'),
      accountId,
      personId: input.personId ?? null,
      purpose: input.purpose,
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

function definedOnly<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
