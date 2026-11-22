# Connect Kapso WhatsApp

Use a clinic-owned WhatsApp account. Keep KAPSO_API_KEY and KAPSO_WEBHOOK_SECRET on the server; never paste them into patient messages or frontend code.

1. Connect your clinic number in Kapso and obtain its WhatsApp phone number ID.
2. Set that ID in Clinic settings. Leave automation paused initially.
3. Set a random shared webhook secret (32+ characters) on your app/worker deployment.
4. Register a **kind=meta** webhook to `https://YOUR_DOMAIN/webhooks/kapso/CLINIC_ID`.

From the deployment:

```bash
docker compose exec app npx tsx scripts/register-kapso.ts --clinic-id 1 --number-id YOUR_NUMBER_ID
```

The helper uses Kapso's documented Platform endpoint and registers the chosen secret. Only one Meta webhook per number is supported; update an existing receiver through Kapso rather than creating duplicates. **Meta-format (`--kind meta`, the default) is the recommended production setup**: one documented payload shape for incoming messages and delivery status. The receiver also accepts Kapso's own event format (`--kind kapso`), which is what Kapso sandbox numbers send; see "Sandbox testing" below. If you run under Coolify rather than Docker Compose, run the same `npx tsx scripts/register-kapso.ts ...` command from the app container's Terminal tab.

Webhook verification uses the exact raw body and hex HMAC-SHA256 from `X-Webhook-Signature`; the clinic number inside the signed body must match its configured number ID. Both `X-Idempotency-Key` and provider message IDs are deduplicated in persistent storage.

## Sandbox testing (Kapso-format webhooks)

Kapso's sandbox lets a single test phone talk to a shared Kapso number without connecting a clinic number. Sandbox numbers support **Kapso event webhooks only**, so register with `--kind kapso`:

```bash
npx tsx scripts/register-kapso.ts --clinic-id 1 --number-id SANDBOX_PHONE_NUMBER_ID --kind kapso
```

Or add the endpoint in the Kapso dashboard (WhatsApp > Configurations > Sandbox WhatsApp > Manage Webhooks) using the URL `https://YOUR_DOMAIN/webhooks/kapso/CLINIC_ID` and the same secret as `KAPSO_WEBHOOK_SECRET`. Select at least: message received, sent, delivered, read and failed. Other events (for example conversation started) are acknowledged and ignored.

The Kapso-format receiver:

- verifies the same `X-Webhook-Signature` (hex HMAC-SHA256 of the exact raw body) and deduplicates on `X-Idempotency-Key`, exactly like the Meta-format receiver;
- reads the event name from the `X-Webhook-Event` header; text, button and interactive replies are used, other media is routed to staff;
- also accepts Kapso's batched envelope (`batch: true`, `data: [...]`) if "debounce into batches" is enabled, though leaving it off is simpler;
- needs the sandbox's phone number ID saved in Clinic settings, as with a real number.

Sandbox limits (from Kapso): text and interactive messages only, no templates, one registered tester number. Reminder messages cannot be tested in the sandbox. Use a real number with a Meta-format webhook before a pilot.

`npm test` exercises both formats end to end against a mock Kapso API. No live Kapso account was used for these tests.

## Reminder template

Create an approved UTILITY template named `jyutrix_appointment_reminder` (or set REMINDER_TEMPLATE), language `en_US` (or your exact approved language). Use numbered body parameters in this order:

> Hello {{1}}, reminder from {{2}}: your appointment is {{3}}. Reference {{4}}. Reply RESCHEDULE or CANCEL to change it, or STOP to stop appointment messages.

Parameters: patient name, clinic name, clinic-local appointment time, appointment reference. Confirm approval in Kapso, then enable “Reminder template approved” in clinic settings. Starter/Pilot jobs are scheduled 24 hours and 2 hours before the appointment; Growth uses 24 hours and 3 hours. A job is created only when the time is still in the future. The legacy approved template remains in use unless the interactive template is separately approved and enabled.

For interactive replies, create a second approved UTILITY template named `jyutrix_appointment_reminder_buttons` (or set `REMINDER_BUTTON_TEMPLATE`) with the same body parameters and exactly three QUICK_REPLY buttons in this order and with these titles: `Confirm`, `Reschedule`, `Cancel`. The worker supplies a signed, appointment-bound payload to each button; do not hard-code payload IDs in Meta/Kapso. Keep `KAPSO_WEBHOOK_SECRET` stable and private because it signs both webhook events and reminder actions. After approval, enable “Quick-reply reminder template approved” in clinic settings. Use the same approved template language as configured by `TEMPLATE_LANGUAGE`. The Confirm action records the patient's response, Reschedule asks for a date and then uses the normal slot-selection and confirmation flow, and Cancel asks the patient to confirm again before cancellation. Invalid, expired, mismatched, or already-closed appointment actions are rejected. Button actions expire when the appointment starts.

Normal replies are sent only inside the latest inbound 24-hour service window. A closed window is surfaced as a staff issue; this release does not invent a generic template to reopen it. STOP withdraws reminder permission and cancels pending notifications; START permits conversation to resume but does not automatically restore reminder consent. A later booking confirmation explicitly captures permission.

If using WhatsApp Business App coexistence, staff must use this application's takeover controls before replying. This release does not detect messages typed directly in the phone app as a takeover signal. For a reliable initial pilot, route staff replies through the Jyutrix inbox and disable other automatic responders on the same number.

Media messages are routed to staff rather than transcribed or interpreted. BSUID-only contact identities are preserved and passed using the documented recipient field; test this route with your account as it becomes relevant. We never fabricate a phone number.

## Source contracts checked during implementation

- https://docs.kapso.ai/docs/platform/webhooks/overview
- https://docs.kapso.ai/docs/platform/webhooks/security
- https://docs.kapso.ai/docs/whatsapp/send-messages/text
- https://docs.kapso.ai/docs/whatsapp/templates/simple-text
- https://docs.kapso.ai/api/platform/v1/webhooks/create-webhook

API version defaults to v24.0, matching the retrieved examples. Revalidate provider contracts before changing it. Sending and receiving have been tested with local fixtures and mocks; no live Kapso account was connected in this build.
