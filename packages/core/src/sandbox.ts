import { InvoicesService } from './billing/invoices.js';
import { SubscriptionsService } from './billing/subscriptions.js';
import { ProductsService } from './catalog/products.js';
import { ChargesService } from './charges/charges.js';
import { CheckoutService } from './checkout/checkout.js';
import { Scheduler } from './clock/scheduler.js';
import { SandboxClock } from './clock/virtual-clock.js';
import { AccountsService } from './connect/accounts.js';
import { TransfersService } from './connect/transfers.js';
import { CustomersService } from './customers/customers.js';
import { EventBus } from './events/event-bus.js';
import { Ledger } from './ledger/balances.js';
import { PayoutsService } from './payouts/payouts.js';
import { RefundsService } from './refunds/refunds.js';
import { ScenarioEngine } from './scenarios/scenario-engine.js';
import type { FidelityMode } from './scenarios/scenario-rule.js';
import { DEFAULT_CONFIG, type CoreContext, type SandboxConfig } from './shared/context.js';
import { createIdGenerator, type IdGenerator } from './shared/ids.js';
import { cryptoRandom, seededRandom, type Random } from './shared/random.js';
import { MemoryStore, type Store, type StoreSnapshot } from './store/store.js';
import { VirtualAccountsService } from './virtual-accounts/virtual-accounts.js';
import { WebhooksService } from './webhooks/webhooks.js';

export interface SandboxOptions {
  readonly store?: Store;
  /** Seed for IDs and chaos, so runs are reproducible. */
  readonly seed?: number;
  readonly config?: Partial<SandboxConfig>;
  /** Start with the clock frozen at this time. */
  readonly frozenAt?: Date;
  /** Wall-clock source (tests can inject one). */
  readonly wallNow?: () => number;
}

export interface SandboxSnapshot {
  readonly takenAt: string;
  readonly store: StoreSnapshot;
}

/** The simulation core: every domain module wired to one store, clock, ledger and event bus. */
export class Sandbox {
  readonly store: Store;
  readonly config: SandboxConfig;
  readonly random: Random;
  readonly ids: IdGenerator;
  readonly clock: SandboxClock;
  readonly scheduler: Scheduler;
  readonly ledger: Ledger;
  readonly events: EventBus;
  readonly scenarios: ScenarioEngine;

  readonly customers: CustomersService;
  readonly products: ProductsService;
  readonly accounts: AccountsService;
  readonly transfers: TransfersService;
  readonly charges: ChargesService;
  readonly invoices: InvoicesService;
  readonly subscriptions: SubscriptionsService;
  readonly checkout: CheckoutService;
  readonly virtualAccounts: VirtualAccountsService;
  readonly refunds: RefundsService;
  readonly payouts: PayoutsService;
  readonly webhooks: WebhooksService;

  constructor(options: SandboxOptions = {}) {
    this.store = options.store ?? new MemoryStore();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.random = options.seed !== undefined ? seededRandom(options.seed) : cryptoRandom();
    this.ids = createIdGenerator(this.random);
    this.clock = new SandboxClock(this.store, options.wallNow);
    if (options.frozenAt) this.clock.freeze(options.frozenAt);
    const nowIso = (): string => this.clock.now().toISOString();
    this.scheduler = new Scheduler(this.store, this.ids, nowIso);
    this.clock.attach(this.scheduler);
    this.ledger = new Ledger(this.store, this.ids, nowIso);
    this.events = new EventBus(this.store, this.ids, nowIso);
    this.scenarios = new ScenarioEngine(this.store, this.ids);

    const ctx: CoreContext = {
      store: this.store,
      clock: this.clock,
      scheduler: this.scheduler,
      ledger: this.ledger,
      events: this.events,
      scenarios: this.scenarios,
      ids: this.ids,
      random: this.random,
      config: this.config,
      now: () => this.clock.now(),
      nowIso,
    };

    this.customers = new CustomersService(ctx);
    this.products = new ProductsService(ctx);
    this.accounts = new AccountsService(ctx);
    this.transfers = new TransfersService(ctx);
    this.charges = new ChargesService(ctx, this.accounts, this.transfers);
    this.invoices = new InvoicesService(ctx);
    this.subscriptions = new SubscriptionsService(ctx, this.charges, this.invoices, this.customers);
    this.checkout = new CheckoutService(ctx, this.products, this.customers, this.charges, this.subscriptions);
    this.virtualAccounts = new VirtualAccountsService(ctx, this.charges);
    this.refunds = new RefundsService(ctx, this.charges);
    this.payouts = new PayoutsService(ctx);
    this.webhooks = new WebhooksService(ctx);
  }

  setFidelity(mode: FidelityMode): void {
    this.config.fidelity = mode;
  }

  snapshot(): SandboxSnapshot {
    return { takenAt: this.clock.now().toISOString(), store: this.store.snapshot() };
  }

  restore(snapshot: SandboxSnapshot): void {
    this.store.restore(snapshot.store);
    this.clock.reload();
  }

  /** Clears all state, including the clock, scenarios and pending jobs. */
  reset(): void {
    this.store.clear();
    this.clock.reload();
  }

  close(): void {
    this.store.close();
  }
}
