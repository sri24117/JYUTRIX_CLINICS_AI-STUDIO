/* Kapso webhook tests: payload parsing, plus the signed route end to end against a mock Kapso API.
 * Run with: npm test */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { normalizeKapsoPayload, normalizeMetaPayload, webhookPayloadKind } from "../src/kapso.js";

const NUMBER_ID = "555000111222";
const TESTER = "919999900001";
const SECRET = crypto.randomBytes(24).toString("hex");
const ADMIN_PASSWORD = "e2e-test-password-12345";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type Json = Record<string, any>;

const kapsoInbound = (id: string, text: string, overrides: Json = {}): Json => ({
  message: {
    id,
    timestamp: "1730092800",
    type: "text",
    from: TESTER,
    from_user_id: "IN.13491208655302741918",
    text: { body: text },
    kapso: { direction: "inbound", status: "received" },
    ...overrides,
  },
  conversation: { id: "conv_1", contact_name: "Test Patient", phone_number: TESTER, phone_number_id: NUMBER_ID },
  is_new_conversation: true,
  phone_number_id: NUMBER_ID,
});

const kapsoStatus = (id: string, status: string): Json => ({
  message: { id, timestamp: "1730092900", type: "text", to: TESTER, kapso: { direction: "outbound", status } },
  conversation: { id: "conv_1", contact_name: "Test Patient", phone_number: TESTER, phone_number_id: NUMBER_ID },
  is_new_conversation: false,
  phone_number_id: NUMBER_ID,
});

const metaInbound = (id: string, text: string): Json => ({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "waba1",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: NUMBER_ID },
            contacts: [{ wa_id: TESTER, profile: { name: "Meta Patient" } }],
            messages: [{ id, from: TESTER, timestamp: "1730092800", type: "text", text: { body: text } }],
          },
        },
      ],
    },
  ],
});

describe("webhookPayloadKind", () => {
  test("recognises Meta, Kapso and batch shapes", () => {
    assert.equal(webhookPayloadKind(metaInbound("wamid.M1", "Hi")), "meta");
    assert.equal(webhookPayloadKind(kapsoInbound("wamid.K1", "Hi")), "kapso");
    assert.equal(webhookPayloadKind({ conversation: { id: "c1" }, phone_number_id: NUMBER_ID }), "kapso");
    assert.equal(webhookPayloadKind({ batch: true, data: [kapsoInbound("wamid.K1", "Hi")] }), "kapso");
  });
  test("rejects anything else", () => {
    assert.equal(webhookPayloadKind({}), null);
    assert.equal(webhookPayloadKind(null), null);
    assert.equal(webhookPayloadKind("text"), null);
    assert.equal(webhookPayloadKind({ hello: "world" }), null);
  });
});

describe("normalizeKapsoPayload: inbound messages", () => {
  test("maps a text message to the same record the Meta parser produces", () => {
    const records = normalizeKapsoPayload(kapsoInbound("wamid.K1", "Hi"), "whatsapp.message.received");
    assert.deepEqual(records, [
      {
        type: "inbound",
        number_id: NUMBER_ID,
        provider_id: "wamid.K1",
        contact: TESTER,
        name: "Test Patient",
        text: "Hi",
        received_at: 1730092800,
        button_payload: null,
        is_media: false,
        status: "received",
      },
    ]);
    const meta = normalizeMetaPayload(metaInbound("wamid.K1", "Hi"));
    const { name: _a, ...kapsoShape } = records[0];
    const { name: _b, ...metaShape } = meta[0];
    assert.deepEqual(kapsoShape, metaShape);
  });

  test("strips a leading plus from the sender", () => {
    const [r] = normalizeKapsoPayload(kapsoInbound("wamid.K2", "Hi", { from: `+${TESTER}` }), "whatsapp.message.received");
    assert.equal(r.contact, TESTER);
  });

  test("falls back to the business-scoped ID when there is no phone number", () => {
    const body = kapsoInbound("wamid.K3", "Hi", { from: undefined });
    delete body.conversation.contact_name;
    const [r] = normalizeKapsoPayload(body, "whatsapp.message.received");
    assert.equal(r.contact, "IN.13491208655302741918");
    assert.equal(r.name, "IN.13491208655302741918");
  });

  test("uses the contact name from the conversation, or 'Patient' when nothing is known", () => {
    const [named] = normalizeKapsoPayload(kapsoInbound("wamid.K4", "Hi"), "whatsapp.message.received");
    assert.equal(named.name, "Test Patient");
    const anon = kapsoInbound("wamid.K5", "Hi", { from: undefined, from_user_id: undefined });
    delete anon.conversation.contact_name;
    const [r] = normalizeKapsoPayload(anon, "whatsapp.message.received");
    assert.equal(r.contact, "");
    assert.equal(r.name, "Patient");
  });

  test("reads an interactive button reply", () => {
    const body = kapsoInbound("wamid.K6", "", {
      type: "interactive",
      text: undefined,
      interactive: { type: "button_reply", button_reply: { id: "jyutrix:payload", title: "Confirm" } },
    });
    const [r] = normalizeKapsoPayload(body, "whatsapp.message.received");
    assert.equal(r.text, "Confirm");
    assert.equal(r.button_payload, "jyutrix:payload");
    assert.equal(r.is_media, false);
  });

  test("routes media to staff", () => {
    const body = kapsoInbound("wamid.K7", "", { type: "image", text: undefined });
    const [r] = normalizeKapsoPayload(body, "whatsapp.message.received");
    assert.equal(r.is_media, true);
    assert.match(r.text, /image/);
  });

  test("handles a batched delivery", () => {
    const body = { batch: true, data: [kapsoInbound("wamid.B1", "One"), kapsoInbound("wamid.B2", "Two")], batch_info: {} };
    const records = normalizeKapsoPayload(body, "whatsapp.message.received");
    assert.deepEqual(records.map((r) => [r.provider_id, r.text]), [["wamid.B1", "One"], ["wamid.B2", "Two"]]);
  });

  test("ignores a 'received' event that is really an outbound echo", () => {
    const body = kapsoInbound("wamid.K8", "Hi", { kapso: { direction: "outbound", status: "sent" } });
    assert.deepEqual(normalizeKapsoPayload(body, "whatsapp.message.received"), []);
  });
});

describe("normalizeKapsoPayload: delivery status and other events", () => {
  for (const status of ["sent", "delivered", "read", "failed"]) {
    test(`maps whatsapp.message.${status} to a status record`, () => {
      const [r] = normalizeKapsoPayload(kapsoStatus("wamid.OUT1", status), `whatsapp.message.${status}`);
      assert.equal(r.type, "status");
      assert.equal(r.provider_id, "wamid.OUT1");
      assert.equal(r.contact, TESTER);
      assert.equal(r.status, status);
      assert.equal(r.number_id, NUMBER_ID);
    });
  }

  test("infers the event from the message when the header is missing", () => {
    const [r] = normalizeKapsoPayload(kapsoStatus("wamid.OUT2", "delivered"), "");
    assert.equal(r.type, "status");
    assert.equal(r.status, "delivered");
    const [i] = normalizeKapsoPayload(kapsoInbound("wamid.K9", "Hi"), "");
    assert.equal(i.type, "inbound");
  });

  test("ignores conversation and other events", () => {
    const body = { conversation: { id: "c1", phone_number_id: NUMBER_ID }, phone_number_id: NUMBER_ID };
    assert.deepEqual(normalizeKapsoPayload(body, "whatsapp.conversation.created"), []);
    assert.deepEqual(normalizeKapsoPayload(kapsoInbound("wamid.K10", "Hi"), "whatsapp.conversation.ended"), []);
  });
});

// ---------------------------------------------------------------------------
// End to end: real server, mock Kapso API, signed requests.
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, label: string, ms = 12_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("signed webhook route (end to end)", () => {
  let server: ChildProcess;
  let mock: http.Server;
  let base = "";
  let cookie = "";
  let csrf = "";
  let serverLog = "";
  const kapsoRequests: { url: string; headers: http.IncomingHttpHeaders; body: Json }[] = [];

  const sign = (raw: string, secret = SECRET) => crypto.createHmac("sha256", secret).update(raw).digest("hex");

  async function webhook(body: unknown, opts: { event?: string; key?: string; secret?: string } = {}) {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Webhook-Signature": sign(raw, opts.secret),
      "X-Idempotency-Key": opts.key || crypto.randomUUID(),
    };
    if (opts.event) headers["X-Webhook-Event"] = opts.event;
    const res = await fetch(`${base}/webhooks/kapso/1`, { method: "POST", headers, body: raw });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Json };
  }

  async function api(method: string, url: string, body?: unknown) {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    assert.ok(res.ok, `${method} ${url} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  before(async () => {
    mock = http.createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        kapsoRequests.push({ url: req.url || "", headers: req.headers, body: data ? JSON.parse(data) : {} });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ messages: [{ id: `wamid.REPLY${kapsoRequests.length}` }] }));
      });
    });
    const mockPort = await freePort();
    await new Promise<void>((r) => mock.listen(mockPort, "127.0.0.1", () => r()));

    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        APP_MODE: "demo",
        PORT: String(port),
        ADMIN_PASSWORD,
        KAPSO_WEBHOOK_SECRET: SECRET,
        KAPSO_API_KEY: "test-api-key",
        KAPSO_BASE_URL: `http://127.0.0.1:${mockPort}`,
        DATABASE_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d) => (serverLog += d));
    server.stderr?.on("data", (d) => (serverLog += d));

    await waitFor(async () => {
      try {
        return (await fetch(`${base}/health`)).ok;
      } catch {
        return false;
      }
    }, "server to start");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200, serverLog);
    csrf = ((await login.json()) as Json).csrf;
    cookie = (login.headers.getSetCookie?.() || [String(login.headers.get("set-cookie") || "")])
      .map((c) => c.split(";")[0])
      .join("; ");

    const clinics: Json[] = await api("GET", "/api/clinics");
    const clinic = clinics.find((c) => c.id === 1);
    assert.ok(clinic, "demo clinic 1 should exist");
    await api("PUT", "/api/clinics/1", { ...clinic, number_id: NUMBER_ID, enabled: true });
  });

  after(async () => {
    server?.kill();
    await new Promise<void>((r) => (mock ? mock.close(() => r()) : r()));
  });

  async function thread() {
    const list: Json[] = await api("GET", "/api/threads?clinic_id=1");
    return list.find((t) => t.contact === TESTER);
  }
  async function messages() {
    const t = await thread();
    return t ? ((await api("GET", `/api/threads/${t.id}/messages`)) as Json[]) : [];
  }

  test("accepts a signed Kapso message, creates the conversation and replies through the Kapso API", async () => {
    const key = "idem-inbound-1";
    // A current timestamp, as a real event would carry: the app refuses to reply outside WhatsApp's 24-hour window.
    const now = String(Math.floor(Date.now() / 1000));
    const res = await webhook(kapsoInbound("wamid.IN1", "Hi", { timestamp: now }), { event: "whatsapp.message.received", key });
    assert.deepEqual(res, { status: 200, body: { ok: true, accepted: 1 } });

    await waitFor(thread, "the conversation to appear");
    const reply = await waitFor(() => kapsoRequests[0], "the reply to reach the Kapso API").catch(async (err) => {
      const t = await thread();
      throw new Error(
        `${err.message}\nthread=${JSON.stringify(t)}\nmessages=${JSON.stringify(await messages())}\nserver log tail:\n${serverLog.slice(-1200)}`,
      );
    });
    assert.equal(reply.url, `/meta/whatsapp/v24.0/${NUMBER_ID}/messages`);
    assert.equal(reply.headers["x-api-key"], "test-api-key");
    assert.equal(reply.body.to, TESTER);
    assert.equal(reply.body.type, "text");

    const msgs = await waitFor(async () => {
      const m = await messages();
      return m.some((x) => x.direction === "out" && x.status === "accepted") ? m : null;
    }, "the outbound message to be accepted");
    assert.ok(msgs.some((m) => m.direction === "in" && m.text === "Hi"));
  });

  test("applies a delivery status event to the reply", async () => {
    const res = await webhook(kapsoStatus("wamid.REPLY1", "delivered"), { event: "whatsapp.message.delivered" });
    assert.deepEqual(res.body, { ok: true, accepted: 1 });
    const msgs = await waitFor(async () => {
      const m = await messages();
      return m.some((x) => x.direction === "out" && x.status === "delivered") ? m : null;
    }, "the reply to show as delivered");
    assert.ok(msgs.length >= 2);
  });

  test("treats a repeated delivery as a duplicate", async () => {
    const res = await webhook(kapsoInbound("wamid.IN1", "Hi"), { event: "whatsapp.message.received", key: "idem-inbound-1" });
    assert.deepEqual(res, { status: 200, body: { ok: true, duplicate: true } });
  });

  test("acknowledges events that are not messages without storing anything", async () => {
    const body = { conversation: { id: "conv_1", phone_number_id: NUMBER_ID }, phone_number_id: NUMBER_ID };
    const res = await webhook(body, { event: "whatsapp.conversation.created" });
    assert.deepEqual(res, { status: 200, body: { ok: true, accepted: 0 } });
  });

  test("rejects a bad signature", async () => {
    const res = await webhook(kapsoInbound("wamid.IN2", "Hi"), { event: "whatsapp.message.received", secret: "wrong-secret" });
    assert.equal(res.status, 401);
  });

  test("rejects a message for a different WhatsApp number", async () => {
    const body = kapsoInbound("wamid.IN3", "Hi");
    body.phone_number_id = "999999999999";
    const res = await webhook(body, { event: "whatsapp.message.received" });
    assert.equal(res.status, 403);
  });

  test("rejects a payload it does not recognise", async () => {
    const res = await webhook({ hello: "world" }, { event: "whatsapp.message.received" });
    assert.equal(res.status, 422);
  });

  test("confirms a STOP once and then stays silent", async () => {
    const other = "919999900009";
    const now = String(Math.floor(Date.now() / 1000));
    const toOther = () => kapsoRequests.filter((r) => r.body.to === other);
    const stop = await webhook(kapsoInbound("wamid.STOP1", "STOP", { from: other, timestamp: now }), { event: "whatsapp.message.received" });
    assert.equal(stop.status, 200);
    const ack = await waitFor(() => toOther()[0], "the STOP confirmation to be sent");
    assert.match(ack.body.text.body, /stopped/i);
    await webhook(kapsoInbound("wamid.STOP2", "Hello again", { from: other, timestamp: now }), { event: "whatsapp.message.received" });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(toOther().length, 1, "an opted-out patient gets no further bot messages");
  });

  test("still accepts Meta-format webhooks", async () => {
    const res = await webhook(metaInbound("wamid.META1", "Hello from Meta format"));
    assert.deepEqual(res, { status: 200, body: { ok: true, accepted: 1 } });
    await waitFor(async () => (await messages()).some((m) => m.text === "Hello from Meta format"), "the Meta-format message");
  });
});
