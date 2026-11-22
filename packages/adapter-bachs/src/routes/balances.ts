import { serializeBalance } from '../serializers.js';
import { ok, route, type RouteFactory } from './helpers.js';

export const balanceRoutes: RouteFactory = () => [
  route('GET', '/v1/balances', 'balances.list', (req) => ok({ items: req.sandbox.ledger.balancesFor(req.ownerId).map(serializeBalance) })),
];
