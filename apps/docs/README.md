# mockrail docs

## Architecture

A request enters the **HTTP gateway**, which mounts each provider under its own prefix (`/bachs/v1/...`). Shared middleware runs first: key-prefix auth, rate limiting, idempotency, request IDs and the per-request scenario header. The **provider adapter** parses the request into a core command. The **simulation core** applies the command, posts any money movement to the double-entry **ledger**, and emits **domain events**. The **webhook dispatcher** asks every adapter to map each event to provider webhooks, then signs and delivers them on the virtual clock.

Two rules:

1. `packages/core` never knows a provider's wire format.
2. Every adapter has contract tests built from the provider's documented examples.

### Time

The virtual clock is the only source of domain time. On a running server it follows wall time plus an offset, and a ticker runs due jobs. Tests usually freeze it and advance it. Advancing runs every due job in order and stamps each event with that job's run time. Two things use wall time on purpose: rate-limit windows, and webhook signature timestamps (so receivers' tolerance checks still pass after you jump 30 days).

### Fidelity

- `sandbox` (default) mirrors the provider's official sandbox. For example, charges are available immediately.
- `live` adds what live does: charges sit in `pending` for a day, large payouts go through review, Connect capabilities wait for required fields, and deposit refunds are blocked.

## Control plane: `/__sandbox`

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Providers, fidelity, clock |
| `GET /clock` / `POST /clock/advance {by \| to}` / `POST /clock/freeze {at?}` / `POST /clock/unfreeze` / `POST /clock/run-due` | Virtual time |
| `GET/POST/DELETE /scenarios`, `DELETE /scenarios/:id` | Scenario rules (a body with `rules: [...]` loads a file) |
| `POST /fidelity {mode}` | `sandbox` or `live` |
| `POST /deposits {account_number, amount, sender_name?}` / `POST /deposits/:id/release` | Virtual-account deposits; release a held deposit |
| `GET /checkout/:id` / `POST /checkout/:id/pay` | Hosted checkout page, and paying it |
| `POST /subscriptions/:id/end-trial` | End a trial now |
| `GET /events`, `GET /webhooks/events`, `GET /webhooks/deliveries`, `POST /webhooks/events/:id/replay` | Inspect and replay |
| `POST /webhooks/endpoints {provider, url}` | Register a receiver without the provider API |
| `GET/POST /webhooks/chaos {duplicate_rate, drop_rate, delay, reorder_window}` | Delivery chaos |
| `GET /balances?owner=`, `GET /ledger` | Ledger views |
| `POST /reset`, `POST /snapshots`, `POST /snapshots/:id/restore` | State |

## Scenarios

A rule matches an operation, optionally filtered by `reference_prefix`, `owner_id` or `currency`, and forces an outcome:

- `succeed`
- `fail:<reason>`, where reason is one of `declined`, `insufficient_funds`, `expired_card`, `processing_error`, `account_name_mismatch`, `bank_rejected`, `invalid_destination`, `review_rejected`
- `delay:<duration>`, e.g. `delay:1h`
- `partial:<amount>:<currency>`, for under- or overpayment

Operations: `charge.create`, `checkout.pay`, `subscription.renew`, `refund.create`, `payout.create`, `deposit.receive`, `*`.

Priority: provider test values (test cards, payout triggers) and the `X-Mockrail-Scenario` request header come first, then the oldest matching rule, then success. Rules are used up after `uses` matches (default 1).

Request headers on any provider route:

- `X-Mockrail-Scenario: fail:declined` forces this request's outcome. `rate_limited` returns a 429.
- `X-Mockrail-Latency: 2s` delays handling, which is useful to provoke `IDEMPOTENCY_IN_PROGRESS`.

See [examples/scenarios.json](../../examples/scenarios.json).

## Writing an adapter

1. Create `packages/adapter-<name>` that depends only on `@mockrail/core`'s public entry.
2. Export a `ProviderAdapter` as `default` (or `adapter`, or `createAdapter()`): routes, auth, idempotency and rate-limit policies, `webhookSigner`, `deliveryPolicy`, `mapDomainEvent` and `renderError`.
3. Keep every documented value in one constants file with its source page, and copy documented examples into `test/fixtures` as contract tests.
4. Run it with `mockrail start --providers bachs,<name>`. Third-party packages load by package name.

Known limitation: domain events are provider-neutral, so with two adapters loaded, each provider's endpoints also receive events for resources created through the other provider's API.
