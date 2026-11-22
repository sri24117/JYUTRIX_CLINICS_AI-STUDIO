# Kapso event-format webhooks (sandbox support)

## Why
The go-live checklist and demo plan use Kapso's sandbox so a test phone can talk to the clinic app
without connecting a real clinic number. Kapso sandbox numbers can only send Kapso-format event
webhooks. The receiver accepted Meta-format payloads only and answered 422 to anything else, so a
sandbox demo could not work.

## Goals
- A signed Kapso-format webhook creates conversations and delivery updates exactly like a Meta-format one.
- Meta-format keeps working unchanged and stays the recommended production setup.

## Non-goals
- No change to sending, reminders, consent, the 24-hour window or the worker.
- No live Kapso account is needed or used for the tests.

## Approaches considered
1. **Add a Kapso-format parser beside the Meta one (chosen).** Both produce the same `NormalizedRecord`s,
   so everything after parsing is shared. Smallest change; the sandbox demo works today.
2. Connect a real clinic number and keep Meta-only. No code change, but needs a spare number and
   Meta's checks; still the right path for a pilot, so it remains documented.

## Design
- `webhookPayloadKind(body)` returns `meta` (has `entry[]`), `kapso` (has `message`, `conversation`,
  `data[]` or `batch`) or `null` (422).
- `normalizeKapsoPayload(body, event)` maps `whatsapp.message.received` to an inbound record and
  `whatsapp.message.{sent,delivered,read,failed}` to status records. Other events return no records and
  the route still answers 200 so Kapso does not retry or pause the webhook.
- Signature check, idempotency, clinic/number check and dedupe are unchanged and shared.
- `register-kapso.ts --kind kapso` registers a Kapso-format webhook with an explicit event list.

## Calls made without asking
- Inbound echoes (`direction: outbound` on a "received" event) are ignored.
- Sender falls back to the business-scoped user ID when no phone number is present, as the Meta parser does.
- `kind=kapso` signatures are assumed to use the same hex HMAC-SHA256 of the raw body as `kind=meta`;
  Kapso's webhook security page documents this algorithm for its webhooks generally. Not verified live.
