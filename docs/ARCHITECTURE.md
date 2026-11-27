# Implementation notes

The original dashboard and clinic workflow informed this release; the unsafe prototype backend was replaced with an explicit production/demo separation. The frontend remains plain HTML/CSS/JavaScript, avoiding an unnecessary framework migration.

## Storage and transactions

SQLAlchemy uses SQLite for local demo/tests and psycopg PostgreSQL for production. Production schema initialization installs btree_gist and a conditional GiST exclusion constraint on clinic + demo/live bucket + appointment range. Application bookings lock the clinic row before checking/inserting/rescheduling. SQLite uses BEGIN IMMEDIATE for test/demo mutation serialization and an exact-start unique expression index. New bookings align with slot duration and cannot span breaks/closing time.

Sessions contain hashed random tokens and persistent expiry; passwords use scrypt with random salt. Cookies are HttpOnly, SameSite=Strict and Secure in production; state-changing staff APIs require a per-session CSRF token. Authentication, role restrictions and tenant checks happen on the backend. Login throttling is database-backed; PostgreSQL advisory locks serialize rate buckets.

## Doctor, service and plan model

Clinics have an active doctor catalog with a schedule per doctor and an active service catalog with a duration and fee per service. Appointment rows carry nullable doctor/service references for legacy compatibility; startup adds missing columns and backfills existing rows to the clinic's first/default doctor and service. PostgreSQL's exclusion constraint groups overlapping appointment ranges by clinic, doctor and demo/live bucket. SQLite uses a doctor-scoped unique start index plus the serialized availability check.

Plan limits are enforced in backend catalog mutations, not just in the UI: Starter/Pilot allows one active doctor and ten active services; Growth allows five doctors and thirty services. Growth schedules 24- and 3-hour reminder jobs when consent and template conditions pass. Growth also includes a consent-based waitlist: it offers a freed slot to one eligible WhatsApp thread at a time, expires after 20 minutes, rechecks booking conflicts at acceptance, and advances on decline/expiry/opt-out. Offers are automated only inside the 24-hour service window; reception must handle out-of-window follow-up under the approved-template process. Optional signed Confirm/Reschedule/Cancel reminder quick replies are implemented behind a separate template-approval flag; live Meta/Kapso behavior remains unverified. Deposits, Pro branch routing and richer conversion analytics are not implemented; see `docs/GROWTH_PLAN.md`.

## Inbound messages

A per-clinic, HMAC-verified Meta-format webhook verifies number ownership, persists delivery IDs and normalized incoming message jobs, then acknowledges. A separate worker processes incoming jobs in clinic order. The conversation state, incoming message, booking and outgoing reply are committed together. Provider message IDs prevent repeated processing even if delivery keys change. Completed inbound job payloads are cleared.

## Outbound messages

Each reply/reminder has a durable job key. The worker commits a dispatch claim before sending, then locks the clinic while checking takeover, consent, window, allowance and booking status. Provider calls are bounded. Known pre-send connectivity failures and HTTP 429 can retry with backoff; unknown outcomes are quarantined. Stale dispatch claims after process termination become uncertain, not automatic retries. Accepted is separate from sent/delivered/read. Exactly-once external delivery is not promised.

Staff takeover uses the same clinic lock, increments a conversation generation and cancels old queued bot messages. Resume starts fresh conversation state. Staff messages can be sent while automated replies are paused. If staff also use the WhatsApp phone app, they must explicitly take over in Jyutrix first; this release does not infer phone-app takeover.

## AI boundary

The default receptionist is deterministic. Optional OpenAI matching selects an index from approved administrative FAQs; it never writes generated medical answers, invents fees or controls bookings. Unknown answers and selected urgent/medical terms go to staff. Keyword escalation is a conservative fallback, not a validated clinical triage system. Add a reviewed evaluation set before expanding language or medical-message handling.

## Data and operations

Patient deletion removes local conversation/message/job content and the contact's enquiry record, and anonymizes appointment contact fields; it leaves non-content audit records. Retention handles aged messages/jobs, inactive threads and enquiry records with no activity in the retention period. Backups and provider-held data require separate policies. Reports exclude demo records and describe operational totals, not causal revenue attribution. Payments and attendance are staff-entered.

## Enquiries, reports, follow-ups and go-live setup

`backend/app/enquiries.py` keeps one `Enquiry` per clinic contact (unique on clinic and contact). `track_whatsapp` runs from `inbound()` for live WhatsApp threads only, and `record_booking` runs from the shared `book()` path, so WhatsApp, staff and waitlist bookings all mark an enquiry booked; nothing else can. Staff bookings with no earlier enquiry create a booked record flagged as direct, which reports count as bookings rather than converted enquiries. Notes and status changes are stored as a capped event list on the enquiry.

Follow-ups are staff reminders computed from `next_followup`; due times are moved to the next clinic opening (reception hours, closed days, leave) with a per-clinic delay (`followup_hours`). Nothing in this layer sends a message: unbooked enquirers have no WhatsApp consent, and sending outside the 24-hour window needs an approved template. A STOP reply, a booking or marking lost clears the task.

`backend/app/reports.py` builds the Performance report on demand in the clinic's time zone from live (non-demo) enquiries, appointments and jobs, and exports it as formula-safe CSV. `backend/app/readiness.py` computes the go-live checklist from real records plus owner-ticked agreements stored on the clinic (`onboarding`); it guides but does not lock the Clinic settings form.

The global voice tool key is a trusted server-to-server integration credential with access to all configured clinic tools; do not give it to clinic users. Configure fixed clinic IDs in trusted agent definitions and issue clinic-specific credentials before offering self-service voice onboarding.

## Saving data

The app keeps its working data in memory and mirrors it to PostgreSQL (`src/persistence.ts`). A save writes only the rows that were added, changed or removed since the previous save:

- After loading at startup and after every save, the app remembers the JSON of each row. The next save compares and writes the difference, so code that changes data does not need to say what it changed.
- Saves that arrive while one is running share a single follow-up save.
- If a set of changes cannot be applied row by row (for example two confirmed appointments swapping slots, which the unique slot index forbids part-way), the save falls back to the original full rewrite inside one transaction. This is logged as a warning.
- A save takes roughly 15 ms with 5,000 stored messages and 125 ms with 100,000 (measured on a laptop; it grows slowly because every row is compared in memory). The previous behaviour rewrote every table on every save, about 5 s at 5,000 messages.
- Expired sessions and slot holds, and audit entries beyond the latest 5,000, are removed from the database.

Every incoming WhatsApp webhook waits for a save before it is acknowledged, so save time directly affects webhook response time (Kapso expects an answer within 10 seconds). `npm test` runs database tests when `TEST_DATABASE_URL` points at a throwaway PostgreSQL.
