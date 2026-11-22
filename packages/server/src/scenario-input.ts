import {
  isCurrencyCode,
  parseDecimal,
  parseDuration,
  SandboxError,
  validateOutcome,
  type CurrencyCode,
  type OperationMatcher,
  type ScenarioFile,
  type ScenarioOutcome,
  type ScenarioRuleInput,
} from '@mockrail/core';

/**
 * Parses an outcome from its short form or JSON:
 *   "succeed" | "fail:declined" | "delay:5m" | "partial:10.00:NGN"
 *   { "kind": "fail", "reason": "declined" } | { "kind": "delay", "settle_after": "5m" }
 *   { "kind": "partial", "received_amount": "10.00", "currency": "NGN" }
 */
export function parseOutcome(input: unknown): ScenarioOutcome {
  let outcome: ScenarioOutcome;
  if (typeof input === 'string') {
    const text = input.trim();
    if (text.startsWith('{')) return parseOutcome(JSON.parse(text));
    const [kind, arg, arg2] = text.split(':');
    switch (kind) {
      case 'succeed':
      case 'success':
        outcome = { kind: 'succeed' };
        break;
      case 'fail':
        outcome = { kind: 'fail', reason: (arg ?? 'declined') as never };
        break;
      case 'delay':
        outcome = { kind: 'delay', settleAfterMs: parseDuration(arg ?? '0') };
        break;
      case 'partial':
        outcome = { kind: 'partial', receivedAmount: amount(arg, arg2) };
        break;
      default:
        throw new SandboxError('bad_request', `Unknown scenario outcome '${text}'. Use succeed, fail:<reason>, delay:<duration> or partial:<amount>:<currency>.`);
    }
  } else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    switch (o.kind) {
      case 'succeed':
        outcome = { kind: 'succeed' };
        break;
      case 'fail':
        outcome = { kind: 'fail', reason: (o.reason ?? 'declined') as never };
        break;
      case 'delay': {
        const raw = o.settle_after ?? o.settleAfter ?? o.settleAfterMs ?? o.settle_after_ms ?? 0;
        outcome = { kind: 'delay', settleAfterMs: parseDuration(raw as string | number) };
        break;
      }
      case 'partial': {
        const received = o.received_amount ?? o.receivedAmount;
        if (received && typeof received === 'object') {
          const r = received as { amountMinor?: unknown; currency?: unknown };
          outcome = { kind: 'partial', receivedAmount: amount(undefined, r.currency as string, BigInt(r.amountMinor as string | number)) };
        } else {
          outcome = { kind: 'partial', receivedAmount: amount(received as string, o.currency as string) };
        }
        break;
      }
      default:
        throw new SandboxError('bad_request', `Unknown outcome kind '${String(o.kind)}'.`);
    }
  } else {
    throw new SandboxError('bad_request', 'A scenario outcome is required.');
  }
  validateOutcome(outcome);
  return outcome;
}

function amount(value: string | undefined, currency: string | undefined, minor?: bigint): { amountMinor: bigint; currency: CurrencyCode } {
  const code = currency?.toUpperCase();
  if (!isCurrencyCode(code)) throw new SandboxError('bad_request', 'Partial outcomes need a supported currency (e.g. partial:10.00:NGN).');
  const parsed = minor ?? parseDecimal(value, code);
  if (parsed === null) throw new SandboxError('bad_request', `'${value}' is not a valid amount.`);
  return { amountMinor: parsed, currency: code };
}

export function parseRule(input: unknown): ScenarioRuleInput {
  if (!input || typeof input !== 'object') throw new SandboxError('bad_request', 'A scenario rule must be an object.');
  const r = input as Record<string, unknown>;
  const m = (r.match ?? {}) as Record<string, unknown>;
  const match: OperationMatcher = {
    operation: (m.operation ?? '*') as OperationMatcher['operation'],
    ...(m.reference_prefix || m.referencePrefix ? { referencePrefix: String(m.reference_prefix ?? m.referencePrefix) } : {}),
    ...(m.owner_id || m.ownerId || m.account ? { ownerId: String(m.owner_id ?? m.ownerId ?? m.account) } : {}),
    ...(m.currency ? { currency: String(m.currency).toUpperCase() as CurrencyCode } : {}),
  };
  const uses = r.uses ?? r.remaining_uses ?? r.remainingUses;
  return {
    ...(typeof r.id === 'string' ? { id: r.id } : {}),
    match,
    outcome: parseOutcome(r.outcome),
    remainingUses: uses === undefined ? 1 : uses === 'unlimited' ? 'unlimited' : Number(uses),
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
  };
}

export function parseScenarioFile(input: unknown): ScenarioFile & { readonly rules: ScenarioRuleInput[] } {
  if (Array.isArray(input)) return { rules: input.map(parseRule) };
  if (!input || typeof input !== 'object') throw new SandboxError('bad_request', 'A scenario file must be an object with a "rules" array.');
  const f = input as Record<string, unknown>;
  if (!Array.isArray(f.rules)) throw new SandboxError('bad_request', 'A scenario file needs a "rules" array.');
  const fidelity = f.fidelity === 'live' || f.fidelity === 'sandbox' ? f.fidelity : undefined;
  return { ...(fidelity ? { fidelity } : {}), rules: f.rules.map(parseRule) };
}
