import { Job, db, nowSec } from "./store.js";
import { readable } from "./booking.js";
import { inbound, offerWaitlistForSlot, queueReply } from "./receptionist.js";
import {
  sendReminderTemplate,
  sendTextMessage,
  signReminderActionToken,
} from "./kapso.js";
import { persistState } from "./persistence.js";

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [15, 60, 180];
const SERVICE_WINDOW_SECONDS = 24 * 3600;

let running = false;
let workerTimer: NodeJS.Timeout | null = null;

function expireWaitlistOffers(): boolean {
  let changed = false;
  const now = nowSec();
  for (const entry of db.waitlist) {
    if (entry.status !== "offered" || !entry.expires || entry.expires > now) continue;
    const clinic = db.clinics.find((c) => c.id === entry.clinic_id);
    if (!clinic) continue;
    const thread = db.threads.find((t) => t.id === entry.thread_id);
    if (thread && thread.mode === "bot" && thread.state?.waitlist_id === entry.id) {
      thread.state = {};
      queueReply(
        clinic,
        thread,
        "The cancellation slot offer has expired. Reply WAITLIST if you would like to join again.",
        `waitlist-expired:${entry.id}`,
        "bot",
      );
    }
    const { offered_starts, offered_doctor_id, offered_service_id } = entry;
    entry.status = "expired";
    entry.expires = null;
    db.audit("system", "waitlist.offer_expired", entry.id, clinic.id);
    if (offered_starts) {
      offerWaitlistForSlot(clinic, offered_starts, offered_doctor_id, offered_service_id);
    }
    changed = true;
  }
  return changed;
}

function monthlyMessageUsage(clinicId: number): number {
  const now = new Date();
  const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0) / 1000);
  return db.jobs.filter(
    (j) =>
      j.clinic_id === clinicId &&
      ["outbound", "reminder"].includes(j.kind) &&
      ["accepted", "sent", "delivered", "read", "uncertain"].includes(j.status) &&
      j.created >= monthStart,
  ).length;
}

async function processJob(job: Job): Promise<void> {
  const now = nowSec();
  const clinic = db.clinics.find((c) => c.id === job.clinic_id);
  if (!clinic) {
    job.status = "cancelled";
    job.error = "Clinic not found";
    return;
  }

  if (job.kind === "inbound") {
    const p = job.payload || {};
    job.status = "dispatching";
    job.attempts += 1;
    inbound(clinic, String(p.contact || ""), String(p.name || "Patient"), String(p.text || ""), job.key, {
      channel: "whatsapp",
      providerId: p.provider_id || null,
      receivedAt: Number(p.received_at) || now,
      buttonPayload: p.button_payload || null,
      isMedia: Boolean(p.is_media),
    });
    job.status = "completed";
    job.error = "";
    return;
  }

  const thread = job.thread_id ? db.threads.find((t) => t.id === job.thread_id) : null;
  if (!thread || thread.channel !== "whatsapp") {
    job.status = "cancelled";
    job.error = "WhatsApp thread not found";
    return;
  }
  if (thread.opted_out) {
    job.status = "cancelled";
    job.error = "Patient opted out";
    if (job.message_id) {
      const m = db.messages.find((x) => x.id === job.message_id);
      if (m) m.status = "cancelled";
    }
    return;
  }

  // Monthly allowance guard
  if (monthlyMessageUsage(clinic.id) >= clinic.monthly_limit) {
    job.status = "failed";
    job.error = "Monthly outgoing message allowance reached";
    thread.attention = job.error;
    return;
  }

  if (job.kind === "outbound") {
    const p = job.payload || {};
    if (p.actor === "bot" && (thread.mode === "human" || Number(p.generation || 0) !== thread.generation)) {
      job.status = "cancelled";
      if (job.message_id) {
        const m = db.messages.find((x) => x.id === job.message_id);
        if (m) m.status = "cancelled";
      }
      return;
    }
    if (thread.last_inbound < now - SERVICE_WINDOW_SECONDS) {
      job.status = "failed";
      job.error = "24-hour WhatsApp reply window closed; contact patient using approved process";
      thread.attention = job.error;
      if (job.message_id) {
        const m = db.messages.find((x) => x.id === job.message_id);
        if (m) m.status = "failed";
      }
      return;
    }

    job.status = "dispatching";
    job.attempts += 1;
    const result = await sendTextMessage(clinic.number_id || "", thread.contact, String(p.text || ""));
    applySendResult(job, thread, result);
    return;
  }

  if (job.kind === "reminder") {
    const appt = job.appointment_id ? db.appointments.find((a) => a.id === job.appointment_id) : null;
    if (
      !appt ||
      appt.status !== "confirmed" ||
      !appt.consent ||
      !thread.consent ||
      appt.starts <= now ||
      (job.payload?.starts && appt.starts !== job.payload.starts)
    ) {
      job.status = "cancelled";
      return;
    }
    if (!clinic.template_approved) {
      job.status = "failed";
      job.error = "Reminder template not marked approved in Clinic settings";
      return;
    }

    job.status = "dispatching";
    job.attempts += 1;
    const useButtons = Boolean(clinic.reminder_buttons_approved);
    const buttonPayloads: [string, string, string] | undefined = useButtons
      ? [
          signReminderActionToken({ clinic_id: clinic.id, appointment_id: appt.id, starts: appt.starts, action: "confirm" }),
          signReminderActionToken({ clinic_id: clinic.id, appointment_id: appt.id, starts: appt.starts, action: "reschedule" }),
          signReminderActionToken({ clinic_id: clinic.id, appointment_id: appt.id, starts: appt.starts, action: "cancel" }),
        ]
      : undefined;

    const result = await sendReminderTemplate(
      clinic.number_id || "",
      thread.contact,
      [appt.name, clinic.name, readable(clinic, appt.starts), `#${appt.id}`],
      { useButtons, buttonPayloads },
    );
    applySendResult(job, thread, result);
  }
}

function applySendResult(
  job: Job,
  thread: { attention: string },
  result: { outcome: "accepted" | "retry" | "failed" | "uncertain"; providerId?: string; error?: string },
): void {
  const msg = job.message_id ? db.messages.find((m) => m.id === job.message_id) : null;
  if (result.outcome === "accepted") {
    job.status = "accepted";
    job.error = "";
    if (msg) {
      msg.status = "accepted";
      if (result.providerId) msg.provider_id = result.providerId;
    }
    return;
  }
  if (result.outcome === "retry" && job.attempts < MAX_ATTEMPTS) {
    const delay = RETRY_DELAYS[Math.min(job.attempts - 1, RETRY_DELAYS.length - 1)];
    job.status = "retry";
    job.due = nowSec() + delay;
    job.error = result.error || "Transient provider error; retrying";
    return;
  }
  if (result.outcome === "uncertain") {
    job.status = "uncertain";
    job.error = result.error || "Uncertain send outcome; review Kapso logs before retrying";
    thread.attention = job.error;
    if (msg) msg.status = "uncertain";
    return;
  }
  job.status = "failed";
  job.error = result.error || "Message delivery failed";
  thread.attention = job.error;
  if (msg) msg.status = "failed";
}

export async function runWorkerTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    db.workerHeartbeat = nowSec();
    let changed = expireWaitlistOffers();

    const now = nowSec();
    const dueJobs = db.jobs
      .filter((j) => ["pending", "retry"].includes(j.status) && j.due <= now)
      .sort((a, b) => a.due - b.due || a.id - b.id)
      .slice(0, 25);

    for (const job of dueJobs) {
      await processJob(job);
      changed = true;
    }

    if (changed) {
      await persistState();
    }
  } catch (err) {
    console.error("[Jyutrix Worker] Tick error:", err);
  } finally {
    running = false;
  }
}

export function startWorker(): void {
  if (workerTimer) return;
  db.workerHeartbeat = nowSec();
  workerTimer = setInterval(() => {
    void runWorkerTick();
  }, 3000);
  workerTimer.unref();
}
