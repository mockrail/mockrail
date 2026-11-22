import type { ScenarioOutcome } from '@mockrail/core';
import { BodyReader } from '../request.js';
import { serializeRefund } from '../serializers.js';
import { created, list, ok, route, type RouteFactory } from './helpers.js';

export const refundRoutes: RouteFactory = () => [
  route('POST', '/v1/refunds', 'refunds.create', (req) => {
    const body = new BodyReader(req.body);
    const paymentId = body.string('payment_id', { required: true });
    const reason = body.string('reason', { max: 500 });
    const simulatedOutcome = body.oneOf('simulated_outcome', ['success', 'failed'] as const);
    // Discrepancy #10: the body has its own idempotency_key, the platform uses the header. Accept both.
    const bodyKey = body.string('idempotency_key', { max: 255 });
    const metadata = body.metadata();
    const charge = paymentId ? req.sandbox.charges.get(req.ownerId, paymentId) : undefined;
    const amount = body.amount('amount', charge?.amount.currency);
    body.done();

    if (bodyKey) {
      const existing = req.sandbox.refunds.list(req.ownerId, { chargeId: paymentId }).find((r) => r.reference === bodyKey);
      if (existing) return ok(serializeRefund(existing));
    }

    const outcomeOverride: ScenarioOutcome | undefined =
      req.scenarioOverride ??
      (simulatedOutcome === 'failed' ? { kind: 'fail', reason: 'processing_error' } : simulatedOutcome === 'success' ? { kind: 'succeed' } : undefined);

    const refund = req.sandbox.refunds.create({
      ownerId: req.ownerId,
      chargeId: paymentId,
      amount: amount ?? null,
      reason: reason ?? null,
      reference: bodyKey ?? null,
      metadata: metadata ?? {},
      // Live: deposits cannot be refunded via the API; the official sandbox does not block it (discrepancy #11).
      allowDepositRefunds: req.sandbox.config.fidelity !== 'live',
      ...(outcomeOverride ? { outcomeOverride } : {}),
    });
    return created(serializeRefund(refund));
  }),

  route('GET', '/v1/refunds', 'refunds.list', (req) =>
    list(req, req.sandbox.refunds.list(req.ownerId, req.query.payment_id ? { chargeId: req.query.payment_id } : {}), serializeRefund),
  ),

  route('GET', '/v1/refunds/by-charge/:payment_id', 'refunds.by_charge', (req) => {
    const paymentId = req.params.payment_id ?? '';
    req.sandbox.charges.get(req.ownerId, paymentId);
    return list(req, req.sandbox.refunds.list(req.ownerId, { chargeId: paymentId }), serializeRefund);
  }),

  route('GET', '/v1/refunds/:refund_id', 'refunds.retrieve', (req) =>
    ok(serializeRefund(req.sandbox.refunds.get(req.ownerId, req.params.refund_id ?? ''))),
  ),
];
