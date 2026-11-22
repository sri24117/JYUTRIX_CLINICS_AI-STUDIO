import crypto from "node:crypto";
import { KAPSO_API_KEY, KAPSO_WEBHOOK_SECRET, nowSec } from "./store.js";

export const KAPSO_API_VERSION = process.env.KAPSO_API_VERSION || "v24.0";
export const KAPSO_BASE_URL = (process.env.KAPSO_BASE_URL || "https://api.kapso.ai").replace(/\/$/, "");
export const REMINDER_TEMPLATE = process.env.REMINDER_TEMPLATE || "jyutrix_appointment_reminder";
export const REMINDER_BUTTON_TEMPLATE =
  process.env.REMINDER_BUTTON_TEMPLATE || "jyutrix_appointment_reminder_buttons";
export const TEMPLATE_LANGUAGE = process.env.TEMPLATE_LANGUAGE || "en_US";

export interface NormalizedRecord {
  type: "inbound" | "status";
  number_id: string;
  provider_id: string;
  contact: string;
  name: string;
  text: string;
  received_at: number;
  button_payload: string | null;
  is_media: boolean;
  status: string;
}

export function verifyKapsoSignature(rawBody: Buffer, signatureHeader: string): boolean {
  if (!KAPSO_WEBHOOK_SECRET || !signatureHeader) return false;
  const cleaned = signatureHeader.trim().replace(/^sha256=/i, "");
  const expected = crypto
    .createHmac("sha256", KAPSO_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(cleaned.toLowerCase(), "utf8");
  const b = Buffer.from(expected.toLowerCase(), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export interface ReminderActionPayload {
  clinic_id: number;
  appointment_id: number;
  starts: number;
  action: "confirm" | "reschedule" | "cancel";
}

export function signReminderActionToken(payload: ReminderActionPayload): string {
  const data = `${payload.clinic_id}:${payload.appointment_id}:${payload.starts}:${payload.action}`;
  const sig = crypto
    .createHmac("sha256", KAPSO_WEBHOOK_SECRET || "dev-reminder-key")
    .update(`reminder:${data}`)
    .digest("hex")
    .slice(0, 24);
  return `jyutrix:${data}:${sig}`;
}

export function verifyReminderActionToken(token: string): ReminderActionPayload | null {
  if (!token || !token.startsWith("jyutrix:")) return null;
  const parts = token.split(":");
  if (parts.length !== 6) return null;
  const clinic_id = Number(parts[1]);
  const appointment_id = Number(parts[2]);
  const starts = Number(parts[3]);
  const action = parts[4];
  const sig = parts[5];
  if (
    !Number.isInteger(clinic_id) ||
    !Number.isInteger(appointment_id) ||
    !Number.isInteger(starts) ||
    !["confirm", "reschedule", "cancel"].includes(action)
  ) {
    return null;
  }
  const expected = crypto
    .createHmac("sha256", KAPSO_WEBHOOK_SECRET || "dev-reminder-key")
    .update(`reminder:${clinic_id}:${appointment_id}:${starts}:${action}`)
    .digest("hex")
    .slice(0, 24);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return {
    clinic_id,
    appointment_id,
    starts,
    action: action as ReminderActionPayload["action"],
  };
}

export function normalizeMetaPayload(body: Record<string, any>): NormalizedRecord[] {
  const records: NormalizedRecord[] = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const numberId = String(value?.metadata?.phone_number_id || "").trim();

      const contactsMap = new Map<string, string>();
      if (Array.isArray(value.contacts)) {
        for (const c of value.contacts) {
          const waId = String(c?.wa_id || c?.user_id || "").trim();
          const profileName = String(c?.profile?.name || "").trim();
          if (waId && profileName) contactsMap.set(waId, profileName);
        }
      }

      if (Array.isArray(value.messages)) {
        for (const msg of value.messages) {
          const providerId = String(msg?.id || "").trim();
          const contact = String(msg?.from || msg?.from_user_id || "").trim().replace(/^\+/, "");
          const name = contactsMap.get(contact) || contactsMap.get(`+${contact}`) || contact || "Patient";
          const ts = Number(msg?.timestamp) || nowSec();
          const msgType = String(msg?.type || "text");
          let text = "";
          let buttonPayload: string | null = null;
          let isMedia = false;

          if (msgType === "text") {
            text = String(msg?.text?.body || "").trim();
          } else if (msgType === "button") {
            text = String(msg?.button?.text || msg?.button?.payload || "").trim();
            buttonPayload = msg?.button?.payload ? String(msg.button.payload) : null;
          } else if (msgType === "interactive") {
            const reply = msg?.interactive?.button_reply || msg?.interactive?.list_reply;
            text = String(reply?.title || reply?.id || "").trim();
            buttonPayload = reply?.id ? String(reply.id) : null;
          } else {
            isMedia = true;
            text = `[Patient sent ${msgType} message — requires staff review]`;
          }

          records.push({
            type: "inbound",
            number_id: numberId,
            provider_id: providerId,
            contact,
            name,
            text,
            received_at: ts,
            button_payload: buttonPayload,
            is_media: isMedia,
            status: "received",
          });
        }
      }

      if (Array.isArray(value.statuses)) {
        for (const st of value.statuses) {
          records.push({
            type: "status",
            number_id: numberId,
            provider_id: String(st?.id || "").trim(),
            contact: String(st?.recipient_id || "").trim(),
            name: "",
            text: "",
            received_at: Number(st?.timestamp) || nowSec(),
            button_payload: null,
            is_media: false,
            status: String(st?.status || "").toLowerCase(),
          });
        }
      }
    }
  }
  return records;
}

export interface SendResult {
  outcome: "accepted" | "retry" | "failed" | "uncertain";
  providerId?: string;
  error?: string;
}

async function postKapsoMessage(numberId: string, payload: Record<string, any>): Promise<SendResult> {
  if (!KAPSO_API_KEY) {
    return { outcome: "failed", error: "KAPSO_API_KEY is not configured on the server" };
  }
  if (!numberId) {
    return { outcome: "failed", error: "Clinic WhatsApp phone number ID is not configured" };
  }
  const url = `${KAPSO_BASE_URL}/meta/whatsapp/${KAPSO_API_VERSION}/${encodeURIComponent(numberId)}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": KAPSO_API_KEY,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const data: any = await res.json().catch(() => ({}));
    if (res.ok) {
      const providerId = String(data?.messages?.[0]?.id || data?.id || "");
      return { outcome: "accepted", providerId };
    }
    const errMsg =
      data?.error?.message || data?.detail || data?.message || `Provider HTTP ${res.status}`;
    if (res.status === 429 || res.status >= 500) {
      return { outcome: "retry", error: String(errMsg) };
    }
    return { outcome: "failed", error: String(errMsg) };
  } catch (err: any) {
    clearTimeout(timeout);
    // Network timeout or socket drop after request may have been sent: never auto-retry!
    return {
      outcome: "uncertain",
      error: `Uncertain delivery (${err?.name === "AbortError" ? "request timed out" : err?.message || "network error"}). Check Kapso logs before retrying.`,
    };
  }
}

export async function sendTextMessage(
  numberId: string,
  recipient: string,
  text: string,
): Promise<SendResult> {
  return postKapsoMessage(numberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "text",
    text: { preview_url: false, body: text },
  });
}

export async function sendReminderTemplate(
  numberId: string,
  recipient: string,
  params: [string, string, string, string],
  options: {
    useButtons?: boolean;
    buttonPayloads?: [string, string, string];
  } = {},
): Promise<SendResult> {
  const templateName = options.useButtons ? REMINDER_BUTTON_TEMPLATE : REMINDER_TEMPLATE;
  const components: any[] = [
    {
      type: "body",
      parameters: params.map((value) => ({ type: "text", text: value })),
    },
  ];
  if (options.useButtons && options.buttonPayloads) {
    options.buttonPayloads.forEach((payload, index) => {
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(index),
        parameters: [{ type: "payload", payload }],
      });
    });
  }
  return postKapsoMessage(numberId, {
    messaging_product: "whatsapp",
    to: recipient,
    type: "template",
    template: {
      name: templateName,
      language: { code: TEMPLATE_LANGUAGE },
      components,
    },
  });
}

export async function registerKapsoWebhook(
  numberId: string,
  webhookUrl: string,
): Promise<{ ok: boolean; status: number; data: any }> {
  if (!KAPSO_API_KEY || !KAPSO_WEBHOOK_SECRET) {
    throw new Error("KAPSO_API_KEY and KAPSO_WEBHOOK_SECRET must be set");
  }
  const url = `${KAPSO_BASE_URL}/platform/v1/whatsapp/phone_numbers/${encodeURIComponent(numberId)}/webhooks`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": KAPSO_API_KEY,
    },
    body: JSON.stringify({
      whatsapp_webhook: {
        url: webhookUrl,
        secret_key: KAPSO_WEBHOOK_SECRET,
        kind: "meta",
        events: ["whatsapp.message.received", "whatsapp.message.status"],
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
