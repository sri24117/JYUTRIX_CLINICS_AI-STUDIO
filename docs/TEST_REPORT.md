# Release verification — 14 October 2026

## Patient enquiries, performance report, follow-up queue, go-live setup and CI — 18 November 2026

- Added patient enquiry tracking (one record per clinic contact, created from live WhatsApp conversations or by staff; "booked" only when an appointment exists), an owner performance report with CSV export and baseline comparison, a staff follow-up queue that respects clinic hours, and a per-clinic go-live setup checklist with owner sign-offs. All are staff-side; nothing is sent to patients.
- Added columns `baseline`, `followup_hours` and `onboarding` on clinics and an `enquiries` table, created by the idempotent startup migration.
- Local verification: **131 backend tests passed** on SQLite (Windows, Python 3.12): the 67 above plus 64 new tests covering enquiry creation and demo exclusion, conversion rules, period filters, attendance, CSV formula safety, follow-up outcomes and business-hours timing, STOP and booking closing tasks, setup readiness and sign-offs, role and clinic isolation, and the startup migration for each new column. The new screens were driven in a real browser against a disposable demo server (filters, forms, outcomes, sign-offs, CSV download, HTML in names rendered as text). Mobile layout and visual screenshots were not captured.
- Remote verification: the GitHub Actions workflow "Reliability checks" (run 44348953834, commit `aa17de7`) passed every step: the full test suite on SQLite, the full suite against a PostgreSQL 16 service container (`TEST_DATABASE_URL`), the JavaScript syntax check and the jsdom UI smoke script. This is the first time the suite has run on PostgreSQL, including the per-doctor exclusion constraint and the eight-simultaneous-bookings test. It supersedes the earlier "PostgreSQL … unverified" and "CI has not been run remotely" statements for the automated suite only.
- Known issue: `test_signed_reminder_confirm_button_records_only_matching_appointment` is flaky on Windows because it builds unique IDs from `time.time_ns()`, whose resolution there can repeat a value so the app treats the message as a duplicate. It fails intermittently on the original code too, is unchanged, and passes on Linux CI.

## Website, enquiry, Growth, waitlist and reminder follow-up — 17 November 2026

- Added the public marketing page at `/` and moved the clinic workspace to `/app`.
- Added a public, consent-checked demo request form with IP rate limiting and a honeypot; enquiries are administrator-only, stage-tracked, deletable, and included in the configured retention task.
- Fixed production configuration so it rejects the public local-demo admin password.
- Added doctor-specific schedules, service durations/fees, per-doctor overlap prevention, server-enforced Starter/Growth doctor and service caps, plan-specific reminder timing, and service/doctor selection in booking flows.
- Added an idempotent additive schema migration that backfills existing appointments to each clinic's default doctor/service.
- Added a consent-gated Growth cancellation waitlist with 20-minute offers, accept/pass, expiry progression, STOP cleanup, admin endpoints/UI and retention cleanup. Automated offers are restricted to eligible WhatsApp threads inside the 24-hour service window.
- Added opt-in approved-template reminder quick replies with signed appointment-bound payloads, validation for appointment/clinic/contact/status/expiry, confirm recording, reschedule through normal booking checks and a second cancellation confirmation. Legacy reminder templates remain the default unless the separate button template is approved and enabled.
- Updated Hostinger KVM / `jyutrix.cloud` deployment guidance and canonical `www` redirect.
- Local verification: **67 backend tests passed** on SQLite, including waitlist consent, Growth entitlement, cancellation-to-offer booking, expiry progression, STOP/next-candidate, demo isolation, signed reminder buttons and webhook-to-worker payload handling. DOM UI smoke passed with 75 HTTP requests, including the Growth waitlist entitlement and empty-state view; frontend JavaScript syntax and Python compilation passed. PostgreSQL migration/constraint, Docker Compose, live WhatsApp and actual deployment remain unverified.

## Completed in the original build

- **53 automated backend tests passed** on a disposable SQLite database, Python 3.12.
- **DOM integration smoke passed** against an actual disposable FastAPI HTTP server: 50 requests covering login, overview, slot choice/confirmation, settings save, injected HTML rendered as text, appointment list, inbox takeover, staff reply, delivery view and logout.
- JavaScript syntax check passed.
- Python compilation/import succeeded.
- Compose and CI YAML parsed successfully.
- Local SQLite backup/restore passed integrity and appointment count checks.
- Runtime dependencies are pinned in requirements.lock.txt; application and UI source formatted for review.

Backend tests include authentication/CSRF, session persistence and revocation, clinic isolation, login throttling, explicit appointment confirmation, overlap/grid/break validation, eight simultaneous booking attempts with one winner, cancellation/rescheduling, webhook signature checks, duplicate delivery/message IDs, media/BSUID normalization, staff takeover, uncertain sends, worker-crash quarantine, known-transient retry, service-window checks, template/consent reminder handling, STOP, message allowance, production fail-closed configuration, demo/live report and slot separation, patient deletion and restricted voice requests.

## Not yet verified

- Live Kapso sends/receives, template approval, billing, number health or WhatsApp coexistence.
- Real audio/telephony, call transfers, voice-agent configuration or caller verification.
- Production-grade PostgreSQL behaviour. The automated suite and the exclusion constraint pass against a PostgreSQL 16 service in CI (18 November 2026), but production-scale concurrency, managed-provider extension permissions (`btree_gist`) and backup restore have not been exercised.
- Docker image/Compose startup, HTTPS issuance, or PostgreSQL backup restore on a deployment host. Docker/PostgreSQL services were unavailable here.
- Real-browser layout, keyboard behavior and mobile screenshots. Browser binary download was unavailable; DOM checks do not prove visual layout or browser CSP behavior. The 18 November screens were driven in a real browser pane at DOM level only; mobile layouts and screenshots remain unchecked.
- Live OpenAI matching or comprehensive local-language quality.
- Security penetration testing, provider-specific onboarding, clinic policy/legal approval, or paid customer outcomes.

One installed test-client dependency emitted an httpx deprecation warning; tests completed successfully. It is not evidence of a runtime failure.

## Release decision

This is a deployable, locally tested MVP candidate, not a production-certified system. Complete LIVE_ACCEPTANCE.md in staging and with the pilot clinic before accepting routine patient traffic. Do not advertise unverified language, voice, revenue recovery or compliance claims.
