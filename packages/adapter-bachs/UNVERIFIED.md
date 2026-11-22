# Bachs adapter: verification notes

The adapter was checked page by page against docs.bachs.io on 22 Nov 2026: the API reference, every webhook event page, the webhook endpoint API, and the checkout, payments, subscriptions, refunds, payouts, virtual-account and Connect guides. Documented values live in `src/constants.ts` and `test/fixtures/documented.json`.

This file lists what is **not** taken straight from the docs: sandbox choices, contradictions in the docs (with the side the adapter takes), and what is still unverified or not implemented.

## Sandbox choices (not documented)

| Area | Choice |
| --- | --- |
| Exchange rates | Fixed rates per USD in `SANDBOX_USD_RATES` (e.g. NGN 1500). The docs show live rates only. |
| NGN account resolution | NGN destinations resolve to `SANDBOX ACCOUNT HOLDER`, with the bank name from a small code table. |
| Collection fees | Only documented fees apply: NGN bank transfer 1.5% (cap NGN 2,000), NGN cards 2%, virtual-account deposits 1% (cap NGN 300). USD cards, mobile money and crypto collect no fee. |
| Payout fees | From the Fees page. The quote fee uses the same rules, taken before conversion (this matches the quote example: 100 USD gives 148,500 NGN at 1,500). |
| Requirements | New accounts owe `company.registration_number` and `company.address` (or the `individual.*` equivalents). Sending them through `fields` clears them. |
| Webhook URLs | HTTPS is required, as documented. The sandbox also accepts `http://localhost`. |
| `organization_id` | The platform's account id is `acct_SandboxPlatform01` (set it with `createBachsAdapter({ organizationId })`). |
| Customer-borne fees | `fee_bearer: customer` on charges (gross-up) is not modelled. The merchant always bears the fee. |

## Contradictions in the docs, and the adapter's choice

| # | Topic | Conflict | Adapter choice |
| --- | --- | --- | --- |
| 1 | Status casing | collection.* events use uppercase (SUCCEEDED, FAILED, UNDERPAID); payment objects use lowercase. | As documented in each place. |
| 2 | Payment statuses | The statuses guide lists open/incomplete plus substatuses; PaymentResponse uses created/processing/succeeded/... | PaymentResponse enum (the API reference). A pending charge is `processing`. |
| 3 | Customer shapes | Collection events use `customer.id`; other events use `customer_id`; customer.* events are flat. | Per event, as documented. |
| 4 | Refund status words | Refund object: processing/success/failed and fee_bearer org/customer. refund.* events: processing/paid/failed and merchant/customer. | Each in its own place. |
| 5 | One refund per charge | The guide says one refund per payment, but the refusal table says "ask for the remaining amount or less". | One non-failed refund per charge (409 CONFLICT otherwise). |
| 6 | Deposit refunds | The refunds guide says bank transfers are not refundable; the earlier review found the sandbox does not block them. | Blocked in live fidelity only. |
| 7 | invoice.paid `charge` | The example shows `charge: null`; the field is described as the collecting payment. | Filled whenever a charge was attempted. |
| 8 | Subscription events | The lifecycle guide names no event for active to past_due; the updated-event page says any status transition fires it. | `customer.subscription.updated` on every status change (the event page). |
| 9 | Fresh capability status | The capabilities guide says `restricted` (and that `pending` is unused); the update-account page says `pending`. | `restricted` in live. Sandbox grants `active`. |
| 10 | Rotation overlap | The guide says the old secret stays valid 24 h; the rotate endpoint says it stops immediately. | 24 h overlap (guide). |
| 11 | Rotate response | The guide says to store the new secret returned; the rotate schema has no `signing_secret`. | The response includes `signing_secret`. |
| 12 | Connect event types | The overview lists account.updated etc.; the create-endpoint `event_types` enum omits them. | Accepted in `event_types`. |
| 13 | Destination approval | The guide says banks and wallets are approved at once; the create example shows `pending_review`. | Sandbox approves at once. Live sends crypto wallets to review. |
| 14 | List shapes | The intro says lists return `{items, pagination}`; refunds and payouts return `{total, items}`; webhook events return `{items, total, limit, offset}`. | Each endpoint as documented. |
| 15 | List defaults | Pagination guide default 20; most list endpoints default 50; products 20. | Per endpoint. |
| 16 | Customer on checkout | The object page says `customer` can be null; the GET schema says it is a required object. | Always an object, with null fields. |
| 17 | Destination transfer amount | With platform_fee, the transfer is recorded at the gross, and the platform's cut is a separate fee record. | Recorded as documented; the seller's balance gets gross minus fee. |
| 18 | Quote fee | "The quote carries no fee", but `to_amount` is net of the withdrawal fee. | Fee taken before conversion, so `to_amount` is net. |
| 19 | Timestamps | Envelopes use `.000000+00:00`; nested fields use `Z`. | Envelope `created_at` in the +00:00 form; everything else ISO `Z`. |
| 20 | checkout `payment_status` | Uses `canceled` (one l) while payments use `cancelled`. | Neither occurs in the sandbox (no cancel endpoint). |

## Still unverified or not implemented

- Pages not opened: `GET /v1/webhooks/endpoints/{id}/secret` (the response shape is a guess), the delete-destination response (204 assumed), list connected accounts and the remaining person routes (shapes reuse the add-person response).
- Not implemented: disputes, files and uploads, customer portal sessions, balance settings, `/v1/accounts/me`, checkout settings, the reference lists, bank-account resolve, payment methods and rails, the currency lists, and the `conversion.*` and `dispute.*` events.
- `payment_method.saved` is named in the saved-card guide but missing from the event index and the endpoint enum. The adapter emits it with the guide's fields.
- Permissions and scopes (403 for a missing scope) are not modelled: every `sk_sandbox_` key has every scope.
