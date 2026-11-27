import { Pool } from "pg";
import { db, nowSec } from "./store.js";

function normalizeDatabaseUrl(raw: string): string {
  // Convert legacy SQLAlchemy URL format (postgresql+psycopg://) to standard pg URL
  return raw.trim().replace(/^postgresql\+psycopg:\/\//i, "postgresql://");
}

let pool: Pool | null = null;
let initialized = false;

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

  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  initialized = false;
  snapshots = new Map();
  flushing = null;
  queued = null;

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

    // Remember what was just loaded so the next save writes only what changes after this point.
    const loadedAt = nowSec();
    rememberSnapshots(
      SPECS.map((spec) => diffTable(spec, loadedAt)),
      diffDeliveries().next,
    );
    await removeStaleRows(client, loadedAt, true);

    initialized = true;
    console.log(
      `[Jyutrix] Connected to PostgreSQL (${db.clinics.length} clinics, ${db.users.length} users, ${db.appointments.length} appointments)`,
    );
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Saving. The app keeps its working data in memory and mirrors it to PostgreSQL. Each save used to
// TRUNCATE every table and re-insert every row, so a save got slower with every message ever stored
// (about 5 s at 5,000 messages) and every incoming WhatsApp webhook waits for a save. Now a save
// writes only the rows that were added, changed or removed since the previous save.
//
// How: after each save (and after loading at startup) we remember the JSON of every row. At the next
// save we compare, so no code that changes data has to say what it changed. Bursts of saves are
// combined into one. If a set of changes cannot be applied row by row (for example two confirmed
// appointments swapping slots, which the unique index forbids mid-way), we fall back to the old full
// rewrite, which always produces a consistent database.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, any>;

interface TableSpec {
  table: string;
  /** primary key column */
  pk: string;
  /** other columns, in the order `vals` returns them; the full row JSON goes in `data` */
  cols: string[];
  rows: (now: number) => Iterable<Row>;
  key: (r: Row) => string | number;
  vals: (r: Row) => any[];
}

const AUDIT_ROWS_KEPT = 5000;
const byId = (r: Row) => r.id;

const SPECS: TableSpec[] = [
  {
    table: "clinics",
    pk: "id",
    cols: ["name", "doctor", "phone", "address", "timezone", "fee", "plan", "number_id", "enabled"],
    rows: () => db.clinics,
    key: byId,
    vals: (c) => [c.name, c.doctor, c.phone, c.address, c.timezone, c.fee, c.plan, c.number_id, c.enabled],
  },
  {
    table: "users",
    pk: "id",
    cols: ["username", "email", "clerk_user_id", "role", "clinic_id", "active"],
    rows: () => db.users,
    key: byId,
    vals: (u) => [u.username, u.email || null, u.clerk_user_id || null, u.role, u.clinic_id, u.active],
  },
  {
    table: "login_sessions",
    pk: "token_hash",
    cols: ["user_id", "expires"],
    rows: (now) => [...db.sessions.values()].filter((s) => s.expires > now),
    key: (s) => s.token_hash,
    vals: (s) => [s.user_id, s.expires],
  },
  {
    table: "doctors",
    pk: "id",
    cols: ["clinic_id", "name", "active"],
    rows: () => db.doctors,
    key: byId,
    vals: (d) => [d.clinic_id, d.name, d.active],
  },
  {
    table: "services",
    pk: "id",
    cols: ["clinic_id", "name", "duration", "fee", "active"],
    rows: () => db.services,
    key: byId,
    vals: (s) => [s.clinic_id, s.name, s.duration, s.fee, s.active],
  },
  {
    table: "threads",
    pk: "id",
    cols: ["clinic_id", "contact", "channel", "mode", "updated"],
    rows: () => db.threads,
    key: byId,
    vals: (t) => [t.clinic_id, t.contact, t.channel, t.mode, t.updated],
  },
  {
    table: "messages",
    pk: "id",
    cols: ["thread_id", "direction", "provider_id", "status", "created"],
    rows: () => db.messages,
    key: byId,
    vals: (m) => [m.thread_id, m.direction, m.provider_id, m.status, m.created],
  },
  {
    table: "jobs",
    pk: "id",
    cols: ["clinic_id", "key", "kind", "status", "due"],
    rows: () => db.jobs,
    key: byId,
    vals: (j) => [j.clinic_id, j.key, j.kind, j.status, j.due],
  },
  {
    table: "appointments",
    pk: "id",
    cols: ["clinic_id", "doctor_id", "service_id", "contact", "starts", "ends", "status", "source"],
    rows: () => db.appointments,
    key: byId,
    vals: (a) => [a.clinic_id, a.doctor_id, a.service_id, a.contact, a.starts, a.ends, a.status, a.source],
  },
  {
    table: "slot_holds",
    pk: "id",
    cols: ["clinic_id", "doctor_id", "thread_id", "starts", "ends", "expires"],
    rows: (now) => db.holds.filter((h) => h.expires > now),
    key: byId,
    vals: (h) => [h.clinic_id, h.doctor_id, h.thread_id, h.starts, h.ends, h.expires],
  },
  {
    table: "waitlist_entries",
    pk: "id",
    cols: ["clinic_id", "contact", "status", "created"],
    rows: () => db.waitlist,
    key: byId,
    vals: (w) => [w.clinic_id, w.contact, w.status, w.created],
  },
  {
    table: "enquiries",
    pk: "id",
    cols: ["clinic_id", "contact", "status", "source", "next_followup", "last_activity"],
    rows: () => db.enquiries,
    key: byId,
    vals: (e) => [e.clinic_id, e.contact, e.status, e.source, e.next_followup, e.last_activity],
  },
  {
    table: "sales_leads",
    pk: "id",
    cols: ["name", "clinic_name", "status", "created"],
    rows: () => db.leads,
    key: byId,
    vals: (l) => [l.name, l.clinic_name, l.status, l.created],
  },
  {
    table: "audits",
    pk: "id",
    cols: ["clinic_id", "actor", "action", "created"],
    rows: () => db.audits.slice(-AUDIT_ROWS_KEPT),
    key: byId,
    vals: (a) => [a.clinic_id, a.actor, a.action, a.created],
  },
  {
    table: "reviews",
    pk: "id",
    cols: ["clinic_id", "appointment_id", "rating", "status", "created"],
    rows: () => db.reviews,
    key: byId,
    vals: (r) => [r.clinic_id, r.appointment_id, r.rating, r.status, r.created],
  },
  {
    table: "voice_calls",
    pk: "id",
    cols: ["clinic_id", "call_id", "direction", "provider", "duration_seconds", "billable_minutes", "outcome", "created"],
    rows: () => db.voice_calls,
    key: byId,
    vals: (v) => [v.clinic_id, v.call_id, v.direction, v.provider, v.duration_seconds, v.billable_minutes, v.outcome, v.created],
  },
  {
    table: "recall_campaigns",
    pk: "id",
    cols: ["clinic_id", "kind", "created"],
    rows: () => db.recall_campaigns,
    key: byId,
    vals: (r) => [r.clinic_id, r.kind, r.created],
  },
  {
    table: "recall_dispatches",
    pk: "id",
    cols: ["clinic_id", "campaign_id", "contact", "status", "created"],
    rows: () => db.recall_dispatches,
    key: byId,
    vals: (r) => [r.clinic_id, r.campaign_id, r.contact, r.status, r.created],
  },
  {
    table: "queue_tokens",
    pk: "id",
    cols: ["clinic_id", "date", "session_id", "token_number", "status", "created"],
    rows: () => db.queue_tokens,
    key: byId,
    vals: (q) => [q.clinic_id, q.date, q.session_id, q.token_number, q.status, q.created],
  },
];

type Key = string | number;
type Snapshot = Map<Key, string>;

/** JSON of every row as of the last successful save, per table; "deliveries" holds the dedupe keys. */
let snapshots = new Map<string, Snapshot>();

const stats = { flushes: 0, fullRewrites: 0, lastFlushMs: 0, lastRowsWritten: 0 };
export function persistenceStats(): { flushes: number; fullRewrites: number; lastFlushMs: number; lastRowsWritten: number } {
  return { ...stats };
}

interface TableDiff {
  spec: TableSpec;
  /** rows that already exist in the database and changed */
  updates: any[][];
  /** rows that are new */
  inserts: any[][];
  removed: Key[];
  next: Snapshot;
}

function diffTable(spec: TableSpec, now: number): TableDiff {
  const prev = snapshots.get(spec.table) || new Map<Key, string>();
  const next: Snapshot = new Map();
  const updates: any[][] = [];
  const inserts: any[][] = [];
  for (const row of spec.rows(now)) {
    const k = spec.key(row);
    const json = JSON.stringify(row);
    next.set(k, json);
    if (prev.get(k) === json) continue;
    const params = [k, ...spec.vals(row), json];
    (prev.has(k) ? updates : inserts).push(params);
  }
  const removed: Key[] = [];
  for (const k of prev.keys()) if (!next.has(k)) removed.push(k);
  return { spec, updates, inserts, removed, next };
}

function diffDeliveries(): { added: string[]; removed: string[]; next: Snapshot } {
  const prev = snapshots.get("deliveries") || new Map<Key, string>();
  const next: Snapshot = new Map();
  const added: string[] = [];
  for (const k of db.deliveries) {
    next.set(k, "1");
    if (!prev.has(k)) added.push(k);
  }
  const removed: string[] = [];
  for (const k of prev.keys()) if (!next.has(k)) removed.push(String(k));
  return { added, removed, next };
}

function upsertSql(spec: TableSpec, rowCount: number): string {
  const columns = [spec.pk, ...spec.cols, "data"];
  const width = columns.length;
  const tuples: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    tuples.push(`(${columns.map((_, i) => `$${r * width + i + 1}`).join(",")})`);
  }
  const setList = [...spec.cols, "data"].map((c) => `${c} = EXCLUDED.${c}`).join(", ");
  return `INSERT INTO ${spec.table} (${columns.join(",")}) VALUES ${tuples.join(",")} ON CONFLICT (${spec.pk}) DO UPDATE SET ${setList}`;
}

const MAX_PARAMS = 30_000;
async function upsertRows(client: any, spec: TableSpec, rows: any[][]): Promise<void> {
  if (rows.length === 0) return;
  const width = spec.cols.length + 2;
  const perStatement = Math.max(1, Math.min(500, Math.floor(MAX_PARAMS / width)));
  for (let i = 0; i < rows.length; i += perStatement) {
    const chunk = rows.slice(i, i + perStatement);
    await client.query(upsertSql(spec, chunk.length), chunk.flat());
  }
}

async function deleteKeys(client: any, table: string, pk: string, keys: Key[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 5000) {
    await client.query(`DELETE FROM ${table} WHERE ${pk} = ANY($1)`, [keys.slice(i, i + 5000)]);
  }
}

async function writeMeta(client: any, now: number): Promise<void> {
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
}

let lastCleanup = 0;
/** Rows the app has stopped using that would otherwise stay in the database for good. */
async function removeStaleRows(client: any, now: number, force = false): Promise<void> {
  if (!force && now - lastCleanup < 60) return;
  lastCleanup = now;
  await client.query("DELETE FROM login_sessions WHERE expires <= $1", [now]);
  await client.query("DELETE FROM slot_holds WHERE expires <= $1", [now]);
  if (db.audits.length > AUDIT_ROWS_KEPT) {
    const firstKept = db.audits[db.audits.length - AUDIT_ROWS_KEPT].id;
    await client.query("DELETE FROM audits WHERE id < $1", [firstKept]);
  }
}

function rememberSnapshots(diffs: TableDiff[], deliveries: Snapshot): void {
  const next = new Map<string, Snapshot>();
  for (const d of diffs) next.set(d.spec.table, d.next);
  next.set("deliveries", deliveries);
  snapshots = next;
}

/** Row-by-row save of everything that changed since the previous save. */
async function saveChanges(client: any, now: number): Promise<{ written: number; diffs: TableDiff[]; deliveries: Snapshot }> {
  const diffs = SPECS.map((spec) => diffTable(spec, now));
  const del = diffDeliveries();
  let written = 0;

  await client.query("BEGIN");
  // Order matters for unique indexes: free things up first, then change, then add.
  for (const d of diffs) {
    await deleteKeys(client, d.spec.table, d.spec.pk, d.removed);
    written += d.removed.length;
  }
  if (del.removed.length) await deleteKeys(client, "deliveries", "key", del.removed);
  for (const d of diffs) {
    await upsertRows(client, d.spec, d.updates);
    written += d.updates.length;
  }
  for (const d of diffs) {
    await upsertRows(client, d.spec, d.inserts);
    written += d.inserts.length;
  }
  for (let i = 0; i < del.added.length; i += 5000) {
    await client.query("INSERT INTO deliveries (key, created) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING", [del.added.slice(i, i + 5000), now]);
  }
  written += del.added.length;
  await removeStaleRows(client, now);
  await writeMeta(client, now);
  await client.query("COMMIT");
  return { written, diffs, deliveries: del.next };
}

/** The original save: wipe every table and write everything again. Slow, but always consistent. */
async function rewriteEverything(client: any, now: number): Promise<{ written: number; diffs: TableDiff[]; deliveries: Snapshot }> {
  // Treat every row as new by diffing against an empty snapshot.
  const saved = snapshots;
  snapshots = new Map();
  let diffs: TableDiff[];
  let del: ReturnType<typeof diffDeliveries>;
  try {
    diffs = SPECS.map((spec) => diffTable(spec, now));
    del = diffDeliveries();
  } finally {
    snapshots = saved;
  }
  let written = 0;
  await client.query("BEGIN");
  await client.query(`TRUNCATE ${SPECS.map((s) => s.table).join(", ")}, deliveries`);
  for (const d of diffs) {
    await upsertRows(client, d.spec, d.inserts);
    written += d.inserts.length;
  }
  for (let i = 0; i < del.added.length; i += 5000) {
    await client.query("INSERT INTO deliveries (key, created) SELECT unnest($1::text[]), $2 ON CONFLICT DO NOTHING", [del.added.slice(i, i + 5000), now]);
  }
  written += del.added.length;
  await removeStaleRows(client, now, true);
  await writeMeta(client, now);
  await client.query("COMMIT");
  return { written, diffs, deliveries: del.next };
}

async function flushNow(): Promise<void> {
  if (!pool || !initialized) return;
  const client = await pool.connect();
  const started = performance.now();
  const now = nowSec();
  try {
    let result;
    try {
      result = await saveChanges(client, now);
    } catch (err: any) {
      await client.query("ROLLBACK").catch(() => {});
      console.warn(
        `[Jyutrix] Saving only the changed rows failed (${err?.code || ""} ${err?.message || err}); rewriting the whole database instead.`,
      );
      try {
        result = await rewriteEverything(client, now);
        stats.fullRewrites += 1;
      } catch (err2) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Jyutrix] Failed to persist state to PostgreSQL:", err2);
        throw err2;
      }
    }
    rememberSnapshots(result.diffs, result.deliveries);
    stats.flushes += 1;
    stats.lastRowsWritten = result.written;
    stats.lastFlushMs = Math.round(performance.now() - started);
    if (stats.lastFlushMs > 1000) {
      console.warn(`[Jyutrix] Slow save: ${stats.lastFlushMs} ms for ${result.written} changed rows.`);
    }
  } finally {
    client.release();
  }
}

let flushing: Promise<void> | null = null;
let queued: Promise<void> | null = null;

/** Saves memory to PostgreSQL. Callers that arrive while a save is running share one follow-up save. */
export function persistState(): Promise<void> {
  if (!pool || !initialized) return Promise.resolve();
  if (!flushing) {
    flushing = flushNow().finally(() => {
      flushing = null;
    });
    return flushing;
  }
  if (!queued) {
    queued = flushing
      .catch(() => {})
      .then(() => {
        queued = null;
        return persistState();
      });
  }
  return queued;
}

export async function closePersistence(): Promise<void> {
  const p = pool;
  pool = null;
  initialized = false;
  snapshots = new Map();
  flushing = null;
  queued = null;
  if (p) await p.end().catch(() => {});
}

export async function checkDatabaseHealth(): Promise<void> {
  if (!pool || !initialized) return;
  await pool.query("SELECT 1");
}
