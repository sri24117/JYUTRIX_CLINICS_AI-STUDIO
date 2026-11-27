import { Pool } from "pg";
import { db, nowSec } from "./store.js";

function normalizeDatabaseUrl(raw: string): string {
  // Convert legacy SQLAlchemy URL format (postgresql+psycopg://) to standard pg URL
  return raw.trim().replace(/^postgresql\+psycopg:\/\//i, "postgresql://");
}

let pool: Pool | null = null;
let initialized = false;
let persistQueue: Promise<void> = Promise.resolve();

export function isPostgresConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

export function getDatabaseDialect(): "postgresql" | "memory" {
  return pool && initialized ? "postgresql" : "memory";
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jyutrix_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS clinics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  doctor TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  timezone TEXT NOT NULL,
  fee INTEGER NOT NULL,
  plan TEXT NOT NULL,
  number_id TEXT,
  enabled BOOLEAN NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  clerk_user_id TEXT UNIQUE,
  role TEXT NOT NULL,
  clinic_id INTEGER,
  active BOOLEAN NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS login_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  duration INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  active BOOLEAN NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  contact TEXT NOT NULL,
  channel TEXT NOT NULL,
  mode TEXT NOT NULL,
  updated BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  key TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  due BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  doctor_id INTEGER,
  service_id INTEGER,
  contact TEXT NOT NULL,
  starts BIGINT NOT NULL,
  ends BIGINT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS slot_holds (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  doctor_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  starts BIGINT NOT NULL,
  ends BIGINT NOT NULL,
  expires BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist_entries (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS enquiries (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  next_followup BIGINT,
  last_activity BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_leads (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  clinic_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS audits (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  appointment_id INTEGER NOT NULL,
  rating INTEGER,
  status TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS voice_calls (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  call_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  provider TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  billable_minutes INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL,
  UNIQUE (clinic_id, call_id)
);

CREATE TABLE IF NOT EXISTS recall_campaigns (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS recall_dispatches (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  campaign_id INTEGER NOT NULL,
  contact TEXT NOT NULL,
  status TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_tokens (
  id INTEGER PRIMARY KEY,
  clinic_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  session_id TEXT NOT NULL,
  token_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  created BIGINT NOT NULL,
  data JSONB NOT NULL,
  UNIQUE (clinic_id, date, session_id, token_number)
);

CREATE TABLE IF NOT EXISTS deliveries (
  key TEXT PRIMARY KEY,
  created BIGINT NOT NULL
);
`;

// Database-level guard against two live confirmed appointments for the same doctor and time.
// Created separately from SCHEMA_SQL so that pre-existing duplicate rows cannot stop the app from
// starting: the application still checks for conflicts when booking.
const LIVE_SLOT_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_active_slot
  ON appointments (clinic_id, doctor_id, starts)
  WHERE status = 'confirmed' AND source <> 'demo' AND doctor_id IS NOT NULL
`;

export async function initPersistence(): Promise<void> {
  if (!isPostgresConfigured()) {
    console.log("[Jyutrix] DATABASE_URL not set — running with in-memory storage");
    return;
  }

  const connectionString = normalizeDatabaseUrl(process.env.DATABASE_URL!);
  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    try {
      await client.query(LIVE_SLOT_INDEX_SQL);
    } catch (err: any) {
      console.warn(
        "[Jyutrix] WARNING: could not create the live-slot unique index (uq_live_active_slot). " +
          "Existing rows probably contain duplicate confirmed appointments for the same doctor and time. " +
          "Starting without the database-level double-booking guard; resolve the duplicates and restart. " +
          `Detail: ${err?.message || err}`,
      );
    }

    const [
      clinicsRes,
      usersRes,
      sessionsRes,
      doctorsRes,
      servicesRes,
      threadsRes,
      messagesRes,
      jobsRes,
      apptsRes,
      holdsRes,
      waitlistRes,
      enquiriesRes,
      leadsRes,
      auditsRes,
      reviewsRes,
      voiceCallsRes,
      recallCampaignsRes,
      recallDispatchesRes,
      queueTokensRes,
      deliveriesRes,
      metaRes,
    ] = await Promise.all([
      client.query("SELECT data FROM clinics ORDER BY id"),
      client.query("SELECT data FROM users ORDER BY id"),
      client.query("SELECT data FROM login_sessions"),
      client.query("SELECT data FROM doctors ORDER BY id"),
      client.query("SELECT data FROM services ORDER BY id"),
      client.query("SELECT data FROM threads ORDER BY id"),
      client.query("SELECT data FROM messages ORDER BY id"),
      client.query("SELECT data FROM jobs ORDER BY id"),
      client.query("SELECT data FROM appointments ORDER BY id"),
      client.query("SELECT data FROM slot_holds WHERE expires > $1 ORDER BY id", [nowSec()]),
      client.query("SELECT data FROM waitlist_entries ORDER BY id"),
      client.query("SELECT data FROM enquiries ORDER BY id"),
      client.query("SELECT data FROM sales_leads ORDER BY id"),
      client.query("SELECT data FROM audits ORDER BY id"),
      client.query("SELECT data FROM reviews ORDER BY id"),
      client.query("SELECT data FROM voice_calls ORDER BY id"),
      client.query("SELECT data FROM recall_campaigns ORDER BY id"),
      client.query("SELECT data FROM recall_dispatches ORDER BY id"),
      client.query("SELECT data FROM queue_tokens ORDER BY id"),
      client.query("SELECT key FROM deliveries"),
      client.query("SELECT key, value FROM jyutrix_meta"),
    ]);

    db.clinics = clinicsRes.rows.map((r) => r.data);
    db.users = usersRes.rows.map((r) => r.data);
    db.sessions = new Map(sessionsRes.rows.map((r) => [r.data.token_hash, r.data]));
    db.doctors = doctorsRes.rows.map((r) => r.data);
    db.services = servicesRes.rows.map((r) => r.data);
    db.threads = threadsRes.rows.map((r) => r.data);
    db.messages = messagesRes.rows.map((r) => r.data);
    db.jobs = jobsRes.rows.map((r) => r.data);
    db.appointments = apptsRes.rows.map((r) => r.data);
    db.holds = holdsRes.rows.map((r) => r.data);
    db.waitlist = waitlistRes.rows.map((r) => r.data);
    db.enquiries = enquiriesRes.rows.map((r) => r.data);
    db.leads = leadsRes.rows.map((r) => r.data);
    db.audits = auditsRes.rows.map((r) => r.data);
    db.reviews = reviewsRes.rows.map((r) => r.data);
    db.voice_calls = voiceCallsRes.rows.map((r) => r.data);
    db.recall_campaigns = recallCampaignsRes.rows.map((r) => r.data);
    db.recall_dispatches = recallDispatchesRes.rows.map((r) => r.data);
    db.queue_tokens = queueTokensRes.rows.map((r) => r.data);
    db.deliveries = new Set(deliveriesRes.rows.map((r) => r.key));

    const seqRow = metaRes.rows.find((r) => r.key === "sequences");
    if (seqRow && seqRow.value && typeof seqRow.value === "object") {
      db.restoreSequences(seqRow.value as Record<string, number>);
    } else {
      db.recomputeSequences();
    }

    initialized = true;
    console.log(
      `[Jyutrix] Connected to PostgreSQL (${db.clinics.length} clinics, ${db.users.length} users, ${db.appointments.length} appointments)`,
    );
  } finally {
    client.release();
  }
}

async function flushNow(): Promise<void> {
  if (!pool || !initialized) return;
  const client = await pool.connect();
  const now = nowSec();
  try {
    await client.query("BEGIN");

    await client.query(
      "TRUNCATE clinics, users, login_sessions, doctors, services, threads, messages, jobs, appointments, slot_holds, waitlist_entries, enquiries, sales_leads, audits, reviews, voice_calls, recall_campaigns, recall_dispatches, queue_tokens, deliveries",
    );

    for (const c of db.clinics) {
      await client.query(
        "INSERT INTO clinics (id, name, doctor, phone, address, timezone, fee, plan, number_id, enabled, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [c.id, c.name, c.doctor, c.phone, c.address, c.timezone, c.fee, c.plan, c.number_id, c.enabled, c],
      );
    }
    for (const u of db.users) {
      await client.query(
        "INSERT INTO users (id, username, email, clerk_user_id, role, clinic_id, active, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [u.id, u.username, u.email || null, u.clerk_user_id || null, u.role, u.clinic_id, u.active, u],
      );
    }
    for (const s of db.sessions.values()) {
      if (s.expires > now) {
        await client.query(
          "INSERT INTO login_sessions (token_hash, user_id, expires, data) VALUES ($1,$2,$3,$4)",
          [s.token_hash, s.user_id, s.expires, s],
        );
      }
    }
    for (const d of db.doctors) {
      await client.query(
        "INSERT INTO doctors (id, clinic_id, name, active, data) VALUES ($1,$2,$3,$4,$5)",
        [d.id, d.clinic_id, d.name, d.active, d],
      );
    }
    for (const s of db.services) {
      await client.query(
        "INSERT INTO services (id, clinic_id, name, duration, fee, active, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [s.id, s.clinic_id, s.name, s.duration, s.fee, s.active, s],
      );
    }
    for (const t of db.threads) {
      await client.query(
        "INSERT INTO threads (id, clinic_id, contact, channel, mode, updated, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [t.id, t.clinic_id, t.contact, t.channel, t.mode, t.updated, t],
      );
    }
    for (const m of db.messages) {
      await client.query(
        "INSERT INTO messages (id, thread_id, direction, provider_id, status, created, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [m.id, m.thread_id, m.direction, m.provider_id, m.status, m.created, m],
      );
    }
    for (const j of db.jobs) {
      await client.query(
        "INSERT INTO jobs (id, clinic_id, key, kind, status, due, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [j.id, j.clinic_id, j.key, j.kind, j.status, j.due, j],
      );
    }
    for (const a of db.appointments) {
      await client.query(
        "INSERT INTO appointments (id, clinic_id, doctor_id, service_id, contact, starts, ends, status, source, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [a.id, a.clinic_id, a.doctor_id, a.service_id, a.contact, a.starts, a.ends, a.status, a.source, a],
      );
    }
    for (const h of db.holds) {
      if (h.expires > now) {
        await client.query(
          "INSERT INTO slot_holds (id, clinic_id, doctor_id, thread_id, starts, ends, expires, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [h.id, h.clinic_id, h.doctor_id, h.thread_id, h.starts, h.ends, h.expires, h],
        );
      }
    }
    for (const w of db.waitlist) {
      await client.query(
        "INSERT INTO waitlist_entries (id, clinic_id, contact, status, created, data) VALUES ($1,$2,$3,$4,$5,$6)",
        [w.id, w.clinic_id, w.contact, w.status, w.created, w],
      );
    }
    for (const e of db.enquiries) {
      await client.query(
        "INSERT INTO enquiries (id, clinic_id, contact, status, source, next_followup, last_activity, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [e.id, e.clinic_id, e.contact, e.status, e.source, e.next_followup, e.last_activity, e],
      );
    }
    for (const l of db.leads) {
      await client.query(
        "INSERT INTO sales_leads (id, name, clinic_name, status, created, data) VALUES ($1,$2,$3,$4,$5,$6)",
        [l.id, l.name, l.clinic_name, l.status, l.created, l],
      );
    }
    for (const a of db.audits.slice(-5000)) {
      await client.query(
        "INSERT INTO audits (id, clinic_id, actor, action, created, data) VALUES ($1,$2,$3,$4,$5,$6)",
        [a.id, a.clinic_id, a.actor, a.action, a.created, a],
      );
    }
    for (const r of db.reviews) {
      await client.query(
        "INSERT INTO reviews (id, clinic_id, appointment_id, rating, status, created, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [r.id, r.clinic_id, r.appointment_id, r.rating, r.status, r.created, r],
      );
    }
    for (const vc of db.voice_calls) {
      await client.query(
        "INSERT INTO voice_calls (id, clinic_id, call_id, direction, provider, duration_seconds, billable_minutes, outcome, created, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          vc.id,
          vc.clinic_id,
          vc.call_id,
          vc.direction,
          vc.provider,
          vc.duration_seconds,
          vc.billable_minutes,
          vc.outcome,
          vc.created,
          vc,
        ],
      );
    }
    for (const rc of db.recall_campaigns) {
      await client.query(
        "INSERT INTO recall_campaigns (id, clinic_id, kind, created, data) VALUES ($1,$2,$3,$4,$5)",
        [rc.id, rc.clinic_id, rc.kind, rc.created, rc],
      );
    }
    for (const rd of db.recall_dispatches) {
      await client.query(
        "INSERT INTO recall_dispatches (id, clinic_id, campaign_id, contact, status, created, data) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [rd.id, rd.clinic_id, rd.campaign_id, rd.contact, rd.status, rd.created, rd],
      );
    }
    for (const qt of db.queue_tokens) {
      await client.query(
        "INSERT INTO queue_tokens (id, clinic_id, date, session_id, token_number, status, created, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [qt.id, qt.clinic_id, qt.date, qt.session_id, qt.token_number, qt.status, qt.created, qt],
      );
    }
    for (const k of db.deliveries) {
      await client.query(
        "INSERT INTO deliveries (key, created) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [k, now],
      );
    }

    await client.query(
      `INSERT INTO jyutrix_meta (key, value, updated_at) VALUES ('sequences', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [db.exportSequences(), now],
    );
    await client.query(
      `INSERT INTO jyutrix_meta (key, value, updated_at) VALUES ('worker_heartbeat', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify({ seen: db.workerHeartbeat }), now],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[Jyutrix] Failed to persist state to PostgreSQL:", err);
    throw err;
  } finally {
    client.release();
  }
}

export function persistState(): Promise<void> {
  if (!pool || !initialized) return Promise.resolve();
  persistQueue = persistQueue.then(flushNow, flushNow);
  return persistQueue;
}

export async function checkDatabaseHealth(): Promise<void> {
  if (!pool || !initialized) return;
  await pool.query("SELECT 1");
}
