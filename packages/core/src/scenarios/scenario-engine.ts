import { isCurrencyCode } from '../money/currency.js';
import { SandboxError } from '../shared/errors.js';
import type { IdGenerator } from '../shared/ids.js';
import type { Store } from '../store/store.js';
import { localOf } from '../shared/owners.js';
import {
  FAILURE_REASONS,
  OPERATIONS,
  type FailureReason,
  type OperationMatcher,
  type ScenarioContext,
  type ScenarioOutcome,
  type ScenarioRule,
} from './scenario-rule.js';

const RULES = 'scenario_rules';

export interface ScenarioRuleInput {
  readonly id?: string;
  readonly match: OperationMatcher;
  readonly outcome: ScenarioOutcome;
  readonly remainingUses?: number | 'unlimited';
  readonly description?: string;
}

/** A scenario file loaded in CI. */
export interface ScenarioFile {
  readonly fidelity?: 'sandbox' | 'live';
  readonly rules: readonly ScenarioRuleInput[];
}

interface StoredRule extends ScenarioRule {
  readonly order: number;
}

/**
 * Decides outcomes. A per-request override wins, then the oldest matching rule; with no match
 * the operation succeeds. Rules with limited uses are consumed when they match.
 */
export class ScenarioEngine {
  private order = 0;

  constructor(
    private readonly store: Store,
    private readonly ids: IdGenerator,
  ) {}

  addRule(input: ScenarioRuleInput): ScenarioRule {
    const rule: StoredRule = {
      id: input.id ?? this.ids.next('scn'),
      match: input.match,
      outcome: input.outcome,
      remainingUses: input.remainingUses ?? 1,
      order: this.nextOrder(),
      ...(input.description ? { description: input.description } : {}),
    };
    validateRule(rule);
    this.store.put(RULES, rule);
    return stripOrder(rule);
  }

  removeRule(id: string): boolean {
    return this.store.delete(RULES, id);
  }

  clear(): void {
    for (const rule of this.store.list<StoredRule>(RULES)) this.store.delete(RULES, rule.id);
  }

  list(): ScenarioRule[] {
    return this.sorted().map(stripOrder);
  }

  load(file: ScenarioFile): ScenarioRule[] {
    if (!file || !Array.isArray(file.rules)) {
      throw new SandboxError('bad_request', 'A scenario file needs a "rules" array.');
    }
    return file.rules.map((rule) => this.addRule(rule));
  }

  decide(context: ScenarioContext, override?: ScenarioOutcome): ScenarioOutcome {
    if (override) return override;
    const rule = this.sorted().find((candidate) => matches(candidate.match, context));
    if (!rule) return { kind: 'succeed' };
    if (rule.remainingUses !== 'unlimited') {
      if (rule.remainingUses <= 1) this.store.delete(RULES, rule.id);
      else this.store.put<StoredRule>(RULES, { ...rule, remainingUses: rule.remainingUses - 1 });
    }
    return rule.outcome;
  }

  private nextOrder(): number {
    const highest = this.store.list<StoredRule>(RULES).reduce((max, rule) => Math.max(max, rule.order), 0);
    this.order = Math.max(this.order, highest) + 1;
    return this.order;
  }

  private sorted(): StoredRule[] {
    return this.store.list<StoredRule>(RULES).sort((a, b) => a.order - b.order);
  }
}

function matches(matcher: OperationMatcher, context: ScenarioContext): boolean {
  if (matcher.operation !== '*' && matcher.operation !== context.operation) return false;
  if (matcher.ownerId && matcher.ownerId !== context.ownerId && matcher.ownerId !== localOf(context.ownerId ?? '')) return false;
  if (matcher.currency && matcher.currency !== context.currency) return false;
  if (matcher.referencePrefix) {
    const prefix = matcher.referencePrefix;
    if (!(context.references ?? []).some((ref) => typeof ref === 'string' && ref.startsWith(prefix))) return false;
  }
  return true;
}

function stripOrder(rule: StoredRule): ScenarioRule {
  const { order: _order, ...rest } = rule;
  return rest;
}

export function validateRule(rule: ScenarioRule): void {
  const op = rule.match?.operation;
  if (op !== '*' && !OPERATIONS.includes(op)) {
    throw new SandboxError('bad_request', `Unknown scenario operation '${String(op)}'. Use one of: *, ${OPERATIONS.join(', ')}.`);
  }
  if (rule.match.currency && !isCurrencyCode(rule.match.currency)) {
    throw new SandboxError('bad_request', `Unknown currency '${String(rule.match.currency)}'.`);
  }
  validateOutcome(rule.outcome);
  const uses = rule.remainingUses;
  if (uses !== 'unlimited' && (!Number.isInteger(uses) || uses < 1)) {
    throw new SandboxError('bad_request', 'remainingUses must be a positive integer or "unlimited".');
  }
}

export function validateOutcome(outcome: ScenarioOutcome): void {
  switch (outcome?.kind) {
    case 'succeed':
      return;
    case 'fail':
      if (!FAILURE_REASONS.includes(outcome.reason as FailureReason)) {
        throw new SandboxError('bad_request', `Unknown failure reason '${String(outcome.reason)}'. Use one of: ${FAILURE_REASONS.join(', ')}.`);
      }
      return;
    case 'delay':
      if (!Number.isFinite(outcome.settleAfterMs) || outcome.settleAfterMs < 0) {
        throw new SandboxError('bad_request', 'delay outcomes need a non-negative settleAfterMs.');
      }
      return;
    case 'partial':
      if (typeof outcome.receivedAmount?.amountMinor !== 'bigint' || !isCurrencyCode(outcome.receivedAmount.currency)) {
        throw new SandboxError('bad_request', 'partial outcomes need receivedAmount { amountMinor, currency }.');
      }
      return;
    default:
      throw new SandboxError('bad_request', `Unknown outcome kind '${String((outcome as { kind?: unknown })?.kind)}'.`);
  }
}
