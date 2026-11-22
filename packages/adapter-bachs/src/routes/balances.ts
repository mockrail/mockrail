import { serializeBalances } from '../view.js';
import { ok, route, viewOf, type RouteFactory } from './helpers.js';

export const balanceRoutes: RouteFactory = (options) => [
  route('GET', '/v1/balances', 'balances.retrieve', (req) => ok(serializeBalances(viewOf(req, options), req.ownerId, req.sandbox.ledger.balancesFor(req.ownerId)))),
];
