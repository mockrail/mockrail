# Bachs adapter: what is verified and what is not

Everything in `src/constants.ts` and `test/fixtures/documented.json` comes from Bachs doc pages opened on 21 Nov 2026. The items below are **best guesses**. Confirm each one against its doc page, then move it into the fixtures and add a contract test.

## Payload and object shapes not opened one by one

- Response objects for customers, products, subscriptions, invoices, refunds, payouts, quotes, destinations, accounts, persons, transfers and platform fees (`src/serializers.ts`). Only the documented conventions are certain: decimal-string money, ISO 8601 UTC timestamps, status words, and `available_balance`/`pending_balance`.
- Webhook `data` for `payout.paid`, `payout.failed`, `checkout.expired`, `invoice.paid`, all `subscription.*` events, the `refund.*` events and the Connect events (`BACHS_EVENT_TYPES` marks these with `payloadVerified: false`).
- Subscription event **names** (`subscription.created`, `subscription.updated`, `subscription.canceled`). The docs mention subscription events, but this review did not open them.
- Request body field names on create and update endpoints (for example `product_id`, `customer_email`, `transfer_data`, `card.number`, `destination_id`).

## Paths and codes

- Webhook admin paths (`/v1/webhooks/endpoints`, `/rotate-secret`, `/v1/webhooks/events/:id/resend`). Only `POST /v1/webhooks/replay` is listed verbatim.
- Capability and person sub-routes under `/v1/accounts/:account_id`.
- Error codes other than `BAD_REQUEST`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS` and `PAYOUT_RECIPIENT_INCOMPLETE` (see `ERROR_CODES[*].documented`).
- `X-Bachs-Timestamp` is assumed to be in Unix **seconds**.
- The rate-limit `X-RateLimit-Reset` value is assumed to be a Unix timestamp in seconds.

## Discrepancy choices implemented (from the architecture doc)

| # | Behaviour in this adapter |
| --- | --- |
| 1 | Uppercase status in webhooks, lowercase in API objects |
| 2 | Only `GET /v1/payments/{payment_id}` is implemented |
| 3 | `customer.customer_id` in checkout.completed; nullable `customer.id` in collection events |
| 4 | Retries 1, 3 and 5 days after the preceding failure |
| 5 | `invoice.payment_failed` carries the failed charge |
| 6 | Status words and event names mapped as documented, no renaming |
| 7 | Two decimals everywhere; free checkout amount is `"0"` |
| 8 | Timestamps use `toISOString()` (`Z`, milliseconds). Per-field formats still need the examples |
| 9 | Repeated partial refunds up to the remainder |
| 10 | Both the `Idempotency-Key` header and the body `idempotency_key` are accepted |
| 11 | Deposit refunds return `400 REFUND_NOT_ALLOWED` in live fidelity only |
| 12 | `bank_transfer` in webhooks; `ngn_bank_transfer` in API objects and the payments filter |
| 13 | Over-limit deposits fire `collection.succeeded` and the funds stay pending |
| 14 | No webhook for transitions into `past_due` or for `unpaid` to `active` |
| 15 | Checkout API status stays `open` (`exposeUndocumentedCheckoutStatuses` option to change) |
| 16 | Not applicable yet (`GET /v1/currencies/supported` is not implemented) |
