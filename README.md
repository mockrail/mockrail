# mockrail

A local sandbox for African payment providers. It covers the cases official sandboxes skip: virtual-account deposits, subscription renewals and dunning on a virtual clock, live settlement timing, payout outcomes, and duplicate or out-of-order webhooks.

One provider-neutral simulation engine sits underneath, with a thin adapter per provider. **Bachs** is the first adapter.

## Quick start

```bash
pnpm install
pnpm build
pnpm start                 # same as: node packages/cli/dist/bin.js start
```

```bash
curl -X POST http://127.0.0.1:4010/bachs/v1/checkout-sessions \
  -H "Authorization: Bearer sk_sandbox_local" -H "content-type: application/json" \
  -d '{"pricing":{"currency":"NGN","amount":"2500.00"},"customer":{"email":"ada@example.com"}}'
```

Open the returned `checkout_url` to pay on the simulated hosted checkout page, where the documented Bachs test cards are listed.

## In a test suite

```ts
import { startSandbox } from '@mockrail/testing';

const sb = await startSandbox();            // free port, frozen clock, silent
const api = sb.api('bachs');
const hooks = await sb.webhooks();          // local receiver, registered for you

const product = await api.post('/v1/products', {
  name: 'Pro', price: { currency: 'USD', amount: '29.00' }, billing_cycle: { interval: 'month', frequency: 1 },
});
const checkout = await api.post('/v1/checkout-sessions', {
  product_cart: [{ product_id: product.body.id }], customer: { email: 'a@b.co' },
});
await sb.control.payCheckout(checkout.body.checkout_id);
await sb.advance('1s');

await sb.control.addScenario({ match: { operation: 'subscription.renew' }, outcome: 'fail:insufficient_funds', uses: 'unlimited' });
await sb.advance('31d');                    // renewal fails
await sb.advance('10d');                    // retries at +1, +3, +5 days, then canceled
await hooks.waitFor('customer.subscription.deleted');
await sb.close();
```

## CLI

```
mockrail start [--port 4010] [--store sqlite --db ./state.db] [--fidelity live] [--scenarios examples/scenarios.json] [--frozen]
mockrail clock advance 30d
mockrail deposit 9012345678 15000.00 --sender "Chidi Okafor"
mockrail checkout pay cs_... --card 4000000000000002
mockrail scenarios add --operation payout.create --outcome fail:bank_rejected
mockrail events --webhooks
mockrail events replay evt_...
mockrail reset
```

## Packages

| Package | What it is |
| --- | --- |
| `@mockrail/core` | Money, ledger, virtual clock, scheduler, scenarios, event bus, domain modules, adapter interface |
| `@mockrail/adapter-bachs` | Bachs routes, mappers, webhook signer, delivery policy, contract tests |
| `@mockrail/server` | HTTP gateway, middleware, webhook dispatcher, `/__sandbox` control plane |
| `@mockrail/cli` | `npx mockrail start` and control commands |
| `@mockrail/testing` | `startSandbox()`, control client, webhook collector |

See [apps/docs](apps/docs/README.md) for architecture, the control plane, scenarios and how to write an adapter.

## Development

```bash
pnpm test          # all tests (runs against sources, no build needed)
pnpm build         # turbo build of every package
pnpm typecheck
pnpm changeset     # record a release note for changed packages
```

## License

Apache-2.0
