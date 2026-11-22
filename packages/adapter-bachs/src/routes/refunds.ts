import type { RefundStatus, ScenarioOutcome } from '@mockrail/core';
import { BACHS } from '../constants.js';
import { bachsError } from '../errors.js';
import { BodyReader } from '../request.js';
import { serializeRefund } from '../view.js';
import { created, listWithTotal, ok, route, type RouteFactory } from './helpers.js';

const STATUS_FILTER: Readonly<Record<string, RefundStatus>> = { processing: 'pending', success: 'succeeded', failed: 'failed' };

export const refundRoutes: RouteFactory = () => [
  /**
   * One non-failed refund per charge. Same idempotency_key on the same charge (24 h) returns the
   * existing refund; a reused reference is 409 CONFLICT.
   */
  route('POST', '/v1/refunds', 'refunds.create', (req) => {
    const body = new BodyReader(req.body);
    const chargeId = body.string('charge_id', { required: true });
    const reference = body.string('reference', { required: true, max: 128 });
    const refundAddress = body.nullableString('refund_address');
    const reason = body.nullableString('reason');
    if (reason && reason.length > 500) body.fail('reason', 'Must be at most 500 characters.');
    const feeBearerRaw = body.nullableString('fee_bearer');
    const feeBearer = feeBearerRaw?.toLowerCase();
    if (feeBearer && feeBearer !== 'org' && feeBearer !== 'customer') body.fail('fee_bearer', 'Must be org or customer.');
    const idempotencyKey = body.string('idempotency_key', { max: 255 });
    const simulatedOutcome = body.oneOf('simulated_outcome', ['success', 'failed'] as const);
    const charge = chargeId ? req.sandbox.charges.get(req.ownerId, chargeId) : undefined;
    const amount = body.amount('amount', charge?.amount.currency);
    body.done();

    const outcomeOverride: ScenarioOutcome | undefined =
      req.scenarioOverride ?? (simulatedOutcome === 'failed' ? { kind: 'fail', reason: 'processing_error' } : simulatedOutcome === 'success' ? { kind: 'succeed' } : undefined);

    const { refund } = req.sandbox.refunds.create({
      ownerId: req.ownerId,
      chargeId,
      amount: amount ?? null,
      reason: reason ?? null,
      reference,
      refundAddress: refundAddress ?? null,
      feeBearer: feeBearer === 'customer' ? 'customer' : 'merchant',
      idempotencyKey: idempotencyKey ?? null,
      idempotencyWindowMs: BACHS.refundIdempotencyWindowMs,
      // Bank transfers are not refundable via the API (Refunds guide); the official sandbox does not block it.
      allowBankTransferRefunds: req.sandbox.config.fidelity !== 'live',
      singleRefundPerCharge: true,
      ...(outcomeOverride ? { outcomeOverride } : {}),
    });
    return created(serializeRefund(refund));
  }),

  route('GET', '/v1/refunds', 'refunds.list', (req) => {
    const status = req.query.status;
    if (status && !STATUS_FILTER[status]) throw bachsError('VALIDATION_ERROR', 400, 'status must be processing, success or failed.', { field: 'status' });
    const items = req.sandbox.refunds.list(req.ownerId, status ? { status: STATUS_FILTER[status] as RefundStatus } : {});
    return listWithTotal(req, items, serializeRefund);
  }),

  /** The refund for a charge (a charge takes one refund). */
  route('GET', '/v1/refunds/by-charge/:payment_id', 'refunds.by_charge', (req) => {
    const paymentId = req.params.payment_id ?? '';
    req.sandbox.charges.get(req.ownerId, paymentId);
    const refund = req.sandbox.refunds.list(req.ownerId, { chargeId: paymentId })[0];
    if (!refund) throw bachsError('NOT_FOUND', 404, `No refund found for charge '${paymentId}'.`);
    return ok(serializeRefund(refund));
  }),

  route('GET', '/v1/refunds/:refund_id', 'refunds.retrieve', (req) => ok(serializeRefund(req.sandbox.refunds.get(req.ownerId, req.params.refund_id ?? '')))),
];
