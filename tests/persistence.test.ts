/* Database saving: only changed rows are written, and the database always mirrors memory.
 * Needs a throwaway PostgreSQL: set TEST_DATABASE_URL (the tests wipe the "public" schema). Skipped otherwise. */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const URL = process.env.TEST_DATABASE_URL;

describe("incremental database saves", { skip: URL ? false : "set TEST_DATABASE_URL to run" }, () => {
  let q: Pool;
  let store: typeof import("../src/store.js");
  let persistence: typeof import("../src/persistence.js");
  let db: any;
  const now = Math.floor(Date.now() / 1000);

  const message = (id: number, status = "queued") => ({
    id,
    thread_id: 1,
    direction: id % 2 ? "in" : "out",
    text: `Message number ${id}`,
    provider_id: `wamid.${id}`,
    status,
    created: now,
  });
  const appointment = (id: number, starts: number, status = "confirmed") => ({
    id,
    clinic_id: 1,
    doctor_id: 1,
    service_id: 1,
    contact: `9198000000${id}`,
    name: `Patient ${id}`,
    starts,
    ends: starts + 1800,
    status,
    source: "whatsapp",
  });
  const rows = async (table: string) => (await q.query(`SELECT data FROM ${table} ORDER BY id`)).rows.map((r) => r.data);
  const asJson = (v: unknown) => JSON.parse(JSON.stringify(v));
  const currentXid = async () => (await q.query("SELECT (txid_current() % 4294967296)::text AS x")).rows[0].x as string;
  const rowsTouchedSince = async (table: string, xid: string) =>
    (await q.query(`SELECT count(*)::int AS n FROM ${table} WHERE xmin::text::bigint > $1`, [xid])).rows[0].n as number;

  before(async () => {
    process.env.DATABASE_URL = URL;
    process.env.APP_MODE = "demo";
    q = new Pool({ connectionString: URL, max: 2 });
    await q.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    store = await import("../src/store.js");
    persistence = await import("../src/persistence.js");
    db = store.db;
    await persistence.initPersistence();
    db.threads.push({ id: 1, clinic_id: 1, contact: "919800000001", name: "Seed", channel: "whatsapp", mode: "bot", state: {}, generation: 0, attention: "", updated: now, last_inbound: now, consent: true, opted_out: false });
    for (let i = 1; i <= 20_000; i++) db.messages.push(message(i));
    await persistence.persistState();
  });

  after(async () => {
    await persistence.closePersistence();
    await q.end();
  });

  test("a save with nothing changed writes no rows", async () => {
    const x = await currentXid();
    await persistence.persistState();
    assert.equal(await rowsTouchedSince("messages", x), 0);
    assert.equal(await rowsTouchedSince("threads", x), 0);
  });

  test("changing one message writes exactly that row", async () => {
    const x = await currentXid();
    db.messages[5].status = "delivered";
    await persistence.persistState();
    assert.equal(await rowsTouchedSince("messages", x), 1);
    const saved = (await q.query("SELECT status FROM messages WHERE id = 6")).rows[0];
    assert.equal(saved.status, "delivered");
  });

  test("a save stays fast with a large history", async () => {
    db.messages[100].status = "read";
    const t0 = performance.now();
    await persistence.persistState();
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `one save took ${Math.round(ms)} ms with ${db.messages.length} messages stored`);
  });

  test("added, changed and removed rows are all mirrored in the database", async () => {
    db.messages.push(message(20_001));
    db.messages.splice(10, 1); // message 11 is erased
    db.appointments.push(appointment(1, now + 3600));
    db.appointments.push(appointment(2, now + 7200));
    await persistence.persistState();
    db.appointments[0].status = "cancelled";
    db.appointments.splice(1, 1); // appointment 2 is deleted
    await persistence.persistState();
    assert.deepEqual(await rows("messages"), asJson([...db.messages].sort((a: any, b: any) => a.id - b.id)));
    assert.deepEqual(await rows("appointments"), asJson(db.appointments));
    assert.equal((await q.query("SELECT count(*)::int AS n FROM messages WHERE id = 11")).rows[0].n, 0);
  });

  test("a new row that takes a slot freed in the same save does not trip the double-booking index", async () => {
    // appointment 3 holds the slot and is saved; then a lower-numbered row takes it while 3 is cancelled
    const slot = now + 20_000;
    db.appointments.push(appointment(3, slot));
    await persistence.persistState();
    db.appointments.unshift(appointment(2, slot));
    db.appointments.find((a: any) => a.id === 3).status = "cancelled";
    await persistence.persistState();
    const saved = (await q.query("SELECT id, status FROM appointments WHERE starts = $1 ORDER BY id", [slot])).rows;
    assert.deepEqual(saved, [{ id: 2, status: "confirmed" }, { id: 3, status: "cancelled" }]);
  });

  test("swapping two confirmed slots falls back to a full rewrite and still saves correctly", async () => {
    const s1 = now + 40_000;
    const s2 = now + 50_000;
    db.appointments.push(appointment(10, s1), appointment(11, s2));
    await persistence.persistState();
    const before = persistence.persistenceStats().fullRewrites;
    const a = db.appointments.find((x: any) => x.id === 10);
    const b = db.appointments.find((x: any) => x.id === 11);
    [a.starts, b.starts] = [b.starts, a.starts];
    [a.ends, b.ends] = [b.ends, a.ends];
    await persistence.persistState();
    assert.equal(persistence.persistenceStats().fullRewrites, before + 1);
    const saved = (await q.query("SELECT id, starts::text AS starts FROM appointments WHERE id IN (10, 11) ORDER BY id")).rows;
    assert.deepEqual(saved, [{ id: 10, starts: String(s2) }, { id: 11, starts: String(s1) }]);
    assert.deepEqual(await rows("appointments"), asJson(db.appointments.slice().sort((x: any, y: any) => x.id - y.id)));
  });

  test("expired login sessions and slot holds are not kept", async () => {
    db.sessions.set("tok-old", { token_hash: "tok-old", csrf: "c", user_id: 1, expires: now - 10 });
    db.sessions.set("tok-new", { token_hash: "tok-new", csrf: "c", user_id: 1, expires: now + 3600 });
    db.holds.push({ id: 1, clinic_id: 1, doctor_id: 1, thread_id: 1, starts: now + 100, ends: now + 1900, expires: now - 5 });
    await persistence.persistState();
    const sessions = (await q.query("SELECT token_hash FROM login_sessions ORDER BY token_hash")).rows.map((r) => r.token_hash);
    assert.deepEqual(sessions, ["tok-new"]);
    assert.equal((await q.query("SELECT count(*)::int AS n FROM slot_holds")).rows[0].n, 0);
  });

  test("many simultaneous saves are combined and the final state is correct", async () => {
    const before = persistence.persistenceStats().flushes;
    const saves: Promise<void>[] = [];
    for (let i = 0; i < 25; i++) {
      db.messages[200 + i].status = `status-${i}`;
      saves.push(persistence.persistState());
    }
    await Promise.all(saves);
    const used = persistence.persistenceStats().flushes - before;
    assert.ok(used <= 3, `25 saves needed ${used} database writes`);
    const saved = await rows("messages");
    for (let i = 0; i < 25; i++) assert.equal(saved.find((m: any) => m.id === db.messages[200 + i].id).status, `status-${i}`);
  });

  test("a restart loads exactly what was saved, and the next save does not rewrite everything", async () => {
    const savedMessages = (await q.query("SELECT count(*)::int AS n FROM messages")).rows[0].n;
    assert.equal(savedMessages, db.messages.length);
    const x = await currentXid();
    // simulate what a restart does: reload from the database and save again with nothing changed
    await persistence.initPersistence();
    assert.equal(db.messages.length, savedMessages);
    await persistence.persistState();
    assert.equal(await rowsTouchedSince("messages", x), 0);
  });
});
