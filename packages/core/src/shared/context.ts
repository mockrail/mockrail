import type { Scheduler } from '../clock/scheduler.js';
import type { SandboxClock } from '../clock/virtual-clock.js';
import { DAY, HOUR } from '../clock/duration.js';
import type { EventBus } from '../events/event-bus.js';
import type { Ledger } from '../ledger/balances.js';
import type { FidelityMode } from '../scenarios/scenario-rule.js';
import type { ScenarioEngine } from '../scenarios/scenario-engine.js';
import type { Store } from '../store/store.js';
import type { IdGenerator } from './ids.js';
import type { Random } from './random.js';

/**
 * Provider-neutral engine settings. Provider-specific policy (retry schedules, limits, TTLs)
 * is passed in by adapters per command, so two providers can run side by side.
 */
export interface SandboxConfig {
  /** 'sandbox' mirrors the provider's official sandbox; 'live' adds settlement delay and review states. */
  fidelity: FidelityMode;
  /** Base URL for hosted pages such as the simulated checkout. */
  publicBaseUrl: string;
  /** Delay between a customer paying and the charge finalizing. */
  chargeFinalizeDelayMs: number;
  refundSettleDelayMs: number;
  payoutProcessingDelayMs: number;
  payoutCompletionDelayMs: number;
  /** Mobile money payouts complete after this delay. */
  mobileMoneyCompletionDelayMs: number;
  /** Live fidelity: charges sit in pending for this long before becoming available. */
  liveSettlementDelayMs: number;
  /** Live fidelity: payouts at or above the review threshold spend this long in review. */
  liveReviewDelayMs: number;
  /** Live fidelity: payouts at or above this many minor units go through review. */
  liveReviewThresholdMinor: bigint;
}

export const DEFAULT_CONFIG: SandboxConfig = {
  fidelity: 'sandbox',
  publicBaseUrl: 'http://localhost:4010',
  chargeFinalizeDelayMs: 1_000,
  refundSettleDelayMs: 3_000,
  payoutProcessingDelayMs: 2_000,
  payoutCompletionDelayMs: 5_000,
  mobileMoneyCompletionDelayMs: 10_000,
  liveSettlementDelayMs: DAY,
  liveReviewDelayMs: 2 * HOUR,
  liveReviewThresholdMinor: 100_000_000n,
};

export interface CoreContext {
  readonly store: Store;
  readonly clock: SandboxClock;
  readonly scheduler: Scheduler;
  readonly ledger: Ledger;
  readonly events: EventBus;
  readonly scenarios: ScenarioEngine;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly config: SandboxConfig;
  now(): Date;
  nowIso(): string;
}
