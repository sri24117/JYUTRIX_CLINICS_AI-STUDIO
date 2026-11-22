import {
  APP_MODE,
  Clinic,
  HttpError,
  KAPSO_API_KEY,
  KAPSO_WEBHOOK_SECRET,
  PUBLIC_URL,
  db,
  ensureCatalog,
  nowSec,
} from "./store.js";

export const SIGNOFFS: Record<string, [string, string]> = {
  staff_trained: [
    "Reception staff are trained",
    "They know how to take over a chat, enter phone and walk-in bookings, record attendance and review failed sends.",
  ],
  privacy_approved: [
    "Privacy notice and consent wording approved by the clinic",
    "The clinic has approved how patient data, consent, retention and deletion are handled under the rules that apply to it.",
  ],
  emergency_routing: [
    "Urgent questions and staff cover agreed",
    "Someone covers the inbox, urgent questions go to a phone number, and patients are told not to wait for WhatsApp in an emergency.",
  ],
  pilot_terms: [
    "Pilot scope, message allowance, support hours and price agreed in writing",
    "Includes renewal terms and any provider charges or taxes.",
  ],
  incident_contact: [
    "Owner contact and fallback plan for problems agreed",
    "If messaging fails, automation is paused and reception handles patients while it is fixed.",
  ],
};

function makeItem(
  key: string,
  phase: "setup" | "test" | "launch",
  title: string,
  detail: string,
  done: boolean,
  options: { required?: boolean; kind?: "auto" | "manual"; view?: string | null } = {},
) {
  return {
    key,
    phase,
    title,
    detail,
    done: Boolean(done),
    required: options.required ?? true,
    kind: options.kind ?? "auto",
    view: options.view ?? null,
    signed_by: null as string | null,
    signed_at: null as number | null,
  };
}

export function computeReadiness(clinic: Clinic, nowInput?: number) {
  const now = Math.floor(nowInput || nowSec());
  const cid = clinic.id;
  const { doctors, services } = ensureCatalog(clinic);
  const team = db.users.filter(
    (u) => u.clinic_id === cid && u.active && ["owner", "receptionist"].includes(u.role),
  ).length;
  const signoffs = clinic.onboarding?.signoffs || {};
  const prod = APP_MODE === "production";

  const items = [
    makeItem(
      "profile",
      "setup",
      "Clinic profile completed",
      "Name, phone, address and time zone are what patients are told.",
      Boolean(clinic.name && clinic.phone && clinic.address && clinic.timezone),
      { view: "settings" },
    ),
    makeItem(
      "team",
      "setup",
      "Staff accounts created",
      "At least one owner or receptionist can sign in for this clinic.",
      team > 0,
      { view: "settings" },
    ),
    makeItem(
      "doctors_services",
      "setup",
      "Doctor and services added",
      "At least one active doctor and one active service, with hours.",
      doctors.some((d) => d.active) && services.some((s) => s.active),
      { view: "settings" },
    ),
    makeItem(
      "faqs",
      "setup",
      "Approved FAQs added",
      "Add the answers the clinic has approved (five or more is a good start). Anything else goes to staff.",
      (clinic.faqs || []).length >= 1,
      { view: "settings" },
    ),
    makeItem(
      "plan_active",
      "setup",
      "Plan is active",
      "An expired plan sends every conversation to staff.",
      !clinic.pilot_end || clinic.pilot_end > now,
      { view: "settings" },
    ),
    makeItem(
      "server_keys",
      "setup",
      "WhatsApp provider keys set on the server",
      "The person deploying Jyutrix sets KAPSO_API_KEY and KAPSO_WEBHOOK_SECRET; they are never entered in the browser.",
      Boolean(KAPSO_API_KEY && KAPSO_WEBHOOK_SECRET),
    ),
    makeItem(
      "number",
      "setup",
      "WhatsApp number connected",
      "An administrator adds the clinic's WhatsApp phone number ID in Clinic settings, then registers the webhook below.",
      Boolean(clinic.number_id),
      { view: "settings" },
    ),
    makeItem(
      "template",
      "setup",
      "Reminder template approved",
      "Approve the reminder template in Kapso/Meta, then tick it in Clinic settings.",
      clinic.template_approved,
      { view: "settings" },
    ),
    makeItem(
      "template_buttons",
      "setup",
      "Quick-reply reminder template approved (optional)",
      "Lets patients confirm, reschedule or cancel from the reminder.",
      clinic.reminder_buttons_approved,
      { required: false, view: "settings" },
    ),
    makeItem(
      "automation_on",
      "test",
      "Automation switched on for testing",
      "The bot only answers while automation is on. Switch it on once setup is complete, then test before announcing the number.",
      clinic.enabled,
    ),
    makeItem(
      "inbound_seen",
      "test",
      "A real WhatsApp message has reached the inbox",
      "Send a message from a staff phone to the clinic number. This proves the webhook and signature work.",
      db.threads.some((t) => t.clinic_id === cid && t.channel !== "demo" && t.last_inbound > 0),
      { view: "inbox" },
    ),
  ];

  if (!prod) {
    items.push(
      makeItem(
        "demo_test",
        "test",
        "Demo conversation completed",
        "In Try the demo, send BOOK, pick a slot, then reply YES. Demo chats are switched off in production.",
        db.appointments.some((a) => a.clinic_id === cid && a.source === "demo"),
        { view: "demo" },
      ),
    );
  }

  items.push(
    makeItem(
      "live_booking",
      "test",
      "A real WhatsApp booking has been completed (recommended)",
      "Book a fictional patient from a staff phone, as in the live acceptance checklist.",
      db.appointments.some((a) => a.clinic_id === cid && a.source === "whatsapp"),
      { required: false, view: "appointments" },
    ),
  );

  for (const [key, [title, detail]] of Object.entries(SIGNOFFS)) {
    const item = makeItem(key, "launch", title, detail, Boolean(signoffs[key]), { kind: "manual" });
    if (signoffs[key]) {
      item.signed_by = signoffs[key].by;
      item.signed_at = signoffs[key].at;
    }
    items.push(item);
  }

  items.push(
    makeItem(
      "baseline",
      "launch",
      "Before-pilot numbers recorded (recommended)",
      "Typical weekly enquiries, bookings and no-show rate, so results can be compared fairly.",
      Boolean(clinic.baseline),
      { required: false, view: "reports" },
    ),
  );

  const required = items.filter((i) => i.required);
  const openRequired = required.filter((i) => !i.done);

  return {
    clinic_id: cid,
    mode: APP_MODE,
    enabled: Boolean(clinic.enabled),
    items,
    progress: { done: required.length - openRequired.length, total: required.length },
    ready: openRequired.length === 0,
    can_enable: required.filter((i) => i.phase === "setup").every((i) => i.done),
    blockers: openRequired.map((i) => i.title),
    webhook_url: `${PUBLIC_URL}/webhooks/kapso/${cid}`,
  };
}

export function setSignoff(clinic: Clinic, key: string, done: boolean, actor: string): void {
  if (!SIGNOFFS[key]) {
    throw new HttpError(404, "Unknown onboarding item");
  }
  const current = { ...(clinic.onboarding?.signoffs || {}) };
  if (done) {
    current[key] = { by: actor, at: nowSec() };
  } else {
    delete current[key];
  }
  clinic.onboarding = { ...(clinic.onboarding || {}), signoffs: current };
  db.audit(
    actor,
    done ? "clinic.onboarding_signed" : "clinic.onboarding_withdrawn",
    `${clinic.id}:${key}`,
    clinic.id,
  );
}

export function enableAutomation(clinic: Clinic, actor: string): void {
  if (clinic.enabled) return;
  const state = computeReadiness(clinic);
  const missing = state.items
    .filter((i) => i.required && i.phase === "setup" && !i.done)
    .map((i) => i.title);
  if (missing.length) {
    throw new HttpError(409, `Finish setup first: ${missing.join("; ")}`);
  }
  clinic.enabled = true;
  db.audit(actor, "clinic.automation_enabled", clinic.id, clinic.id);
}
