import {
  Appointment,
  Clinic,
  Doctor,
  HttpError,
  ReviewRecord,
  Service,
  Thread,
  WaitlistEntry,
  db,
  ensureCatalog,
  limitsFor,
  nowSec,
} from "./store.js";
import {
  SLOT_HOLD_SECONDS,
  addDaysDateStr,
  available,
  book,
  cancelReminders,
  checkSlot,
  createSlotHold,
  defaultDoctor,
  defaultService,
  isInWalkinWindow,
  localParts,
  parseDateStr,
  readable,
  releaseThreadHolds,
  reschedule,
  zonedToEpoch,
} from "./booking.js";
import { onOptOut, trackWhatsApp } from "./enquiries.js";
import { verifyReminderActionToken } from "./kapso.js";
import { getQueueBoard, issueQueueToken } from "./queue.js";

const MEDICAL =
  /\b(medicine|medication|dosage|diagnos|prescrib|antibiotic|chest pain|bleeding|breath|emergency|suicide|overdose|severe pain|swelling|guarantee|treatment success|pain|symptom|cure|fever)\w*|రక్త|శ్వాస|अत्यधिक|सांस/i;
const BOOKING = /\b(book|booking|appointment|slot|visit|appt|kavali)\b|అపాయింట్|బుక్|अपॉइंट|बुक/i;
const TOKEN_CMD = /\b(token|queue|line|waiting number)\b|టోకెన్|टोकन/i;
const HUMAN = /\b(human|staff|receptionist|complaint|agent|person|help me)\b|సిబ్బంది|मनुष्य|स्टाफ/i;

const OFFER_SECONDS = 20 * 60;
const SERVICE_WINDOW_SECONDS = 24 * 3600;

export function getThread(
  clinic: Clinic,
  contact: string,
  name: string,
  channel: "whatsapp" | "demo" = "whatsapp",
): Thread {
  let row = db.threads.find(
    (t) => t.clinic_id === clinic.id && t.contact === contact && t.channel === channel,
  );
  if (!row) {
    row = {
      id: db.nextId("threads"),
      clinic_id: clinic.id,
      contact,
      name,
      channel,
      mode: "bot",
      attention: "",
      state: {},
      consent: false,
      opted_out: false,
      generation: 1,
      last_inbound: 0,
      updated: nowSec(),
    };
    db.threads.push(row);
  }
  return row;
}

// The one message a patient still receives after sending STOP. The worker normally cancels every
// message to an opted-out patient, so this text is marked to be allowed through.
export const OPT_OUT_ACK = "Appointment messages are stopped. Reply START to resume, or call the clinic for help.";

export function queueReply(
  clinic: Clinic,
  thread: Thread,
  text: string,
  key: string,
  actor = "bot",
): string {
  if (db.jobs.some((j) => j.key === key)) return text;
  const msg = {
    id: db.nextId("messages"),
    thread_id: thread.id,
    direction: "out" as const,
    text,
    provider_id: null,
    status: thread.channel === "demo" ? "demo" : "queued",
    created: nowSec(),
  };
  db.messages.push(msg);
  if (thread.channel === "whatsapp") {
    db.jobs.push({
      id: db.nextId("jobs"),
      clinic_id: clinic.id,
      thread_id: thread.id,
      appointment_id: null,
      key,
      kind: "outbound",
      status: "pending",
      attempts: 0,
      due: nowSec(),
      error: "",
      message_id: msg.id,
      payload: { text, actor, generation: thread.generation, allow_opted_out: text === OPT_OUT_ACK },
      created: nowSec(),
    });
  }
  return text;
}

export function takeover(thread: Thread, reason: string, actor = "system"): void {
  thread.mode = "human";
  thread.attention = reason;
  thread.state = {};
  thread.generation += 1;
  releaseThreadHolds(thread.id);
  for (const job of db.jobs) {
    if (
      job.thread_id === thread.id &&
      job.kind === "outbound" &&
      ["pending", "retry", "dispatching"].includes(job.status) &&
      job.payload?.actor === "bot"
    ) {
      job.status = "cancelled";
      if (job.message_id) {
        const msg = db.messages.find((m) => m.id === job.message_id);
        if (msg) msg.status = "cancelled";
      }
    }
  }
  db.audit(actor, "conversation.takeover", thread.id, thread.clinic_id);
}

export function triggerPostVisitReview(clinic: Clinic, appt: Appointment): ReviewRecord | null {
  if (clinic.review_requests_enabled === false) return null;
  const existing = db.reviews.find(
    (r) => r.clinic_id === clinic.id && r.appointment_id === appt.id,
  );
  if (existing) return existing;

  const thread = appt.thread_id
    ? db.threads.find((t) => t.id === appt.thread_id && t.clinic_id === clinic.id) || null
    : db.threads.find(
        (t) =>
          t.clinic_id === clinic.id &&
          t.contact === appt.contact &&
          (appt.source === "demo" ? t.channel === "demo" : t.channel === "whatsapp"),
      ) || null;

  if (!thread || thread.opted_out) return null;
  if (thread.channel === "whatsapp" && !(appt.consent || thread.consent)) return null;

  const now = nowSec();
  const rec: ReviewRecord = {
    id: db.nextId("reviews"),
    clinic_id: clinic.id,
    appointment_id: appt.id,
    thread_id: thread.id,
    patient_name: appt.name,
    contact: appt.contact,
    rating: null,
    status: "requested",
    feedback_note: "",
    created: now,
    responded_at: null,
  };
  db.reviews.push(rec);
  thread.state = {
    step: "review_rating",
    review_id: rec.id,
    appointment_id: appt.id,
    expires: now + 86400,
  };
  thread.updated = now;
  const msg = `Thank you for visiting ${clinic.name}! How was your visit today? Reply with a number from 1 to 5 (5 = excellent).`;
  queueReply(clinic, thread, msg, `review-ask:${clinic.id}:${appt.id}`, "bot");
  db.audit("system", "review.requested", rec.id, clinic.id);
  return rec;
}

export function joinWaitlist(clinic: Clinic, thread: Thread): WaitlistEntry | null {
  if (!limitsFor(clinic).waitlist) return null;
  const existing = db.waitlist
    .filter(
      (e) =>
        e.clinic_id === clinic.id &&
        e.contact === thread.contact &&
        ["waiting", "offered"].includes(e.status),
    )
    .sort((a, b) => b.created - a.created)[0];
  if (existing) return existing;
  const entry: WaitlistEntry = {
    id: db.nextId("waitlist"),
    clinic_id: clinic.id,
    thread_id: thread.id,
    name: thread.name,
    contact: thread.contact,
    consent: true,
    status: "waiting",
    doctor_id: null,
    service_id: null,
    offered_starts: null,
    offered_doctor_id: null,
    offered_service_id: null,
    expires: null,
    created: nowSec(),
  };
  db.waitlist.push(entry);
  db.audit("patient", "waitlist.joined", entry.id, clinic.id);
  return entry;
}

export function offerWaitlistForSlot(
  clinic: Clinic,
  starts: number,
  doctorId: number | null,
  serviceId: number | null,
  demo = false,
): number | null {
  if (demo || !clinic.enabled || !limitsFor(clinic).waitlist) return null;
  const activeOffer = db.waitlist.find(
    (e) =>
      e.clinic_id === clinic.id &&
      e.status === "offered" &&
      e.offered_starts === starts &&
      e.offered_doctor_id === doctorId,
  );
  if (activeOffer) return activeOffer.id;

  try {
    checkSlot(clinic, starts, { doctorId, serviceId });
  } catch {
    return null;
  }

  const doctor = doctorId ? db.doctors.find((d) => d.id === doctorId) : null;
  const service = serviceId ? db.services.find((s) => s.id === serviceId) : null;
  if (!doctor || !service) return null;

  const candidates = db.waitlist
    .filter(
      (e) =>
        e.clinic_id === clinic.id &&
        e.status === "waiting" &&
        e.consent &&
        (e.doctor_id === null || e.doctor_id === doctorId) &&
        (e.service_id === null || e.service_id === serviceId),
    )
    .sort((a, b) => a.created - b.created || a.id - b.id);

  const now = nowSec();
  for (const entry of candidates) {
    const thread = db.threads.find((t) => t.id === entry.thread_id);
    if (
      !thread ||
      thread.channel !== "whatsapp" ||
      thread.opted_out ||
      thread.mode !== "bot" ||
      thread.last_inbound < now - SERVICE_WINDOW_SECONDS
    ) {
      continue;
    }
    const state = thread.state || {};
    if (Object.keys(state).length && (state.expires ?? now + 1) > now) continue;

    entry.status = "offered";
    entry.offered_starts = starts;
    entry.offered_doctor_id = doctorId;
    entry.offered_service_id = serviceId;
    entry.expires = now + OFFER_SECONDS;
    thread.state = {
      step: "waitlist_offer",
      waitlist_id: entry.id,
      starts,
      doctor_id: doctorId,
      service_id: serviceId,
      expires: entry.expires,
    };
    const msg = `A cancellation slot is available: ${readable(clinic, starts)} with ${doctor.name} for ${service.name}. Reply YES within 20 minutes to request it; it is not reserved until confirmed. Reply NO to pass.`;
    queueReply(clinic, thread, msg, `waitlist-offer:${entry.id}:${starts}`, "bot");
    db.audit("system", "waitlist.slot_offered", entry.id, clinic.id);
    return entry.id;
  }
  return null;
}

function acceptWaitlistOffer(clinic: Clinic, thread: Thread, eventKey: string): string {
  const state = thread.state || {};
  const entry = db.waitlist.find((e) => e.id === state.waitlist_id);
  const now = nowSec();
  if (
    !entry ||
    entry.clinic_id !== clinic.id ||
    entry.thread_id !== thread.id ||
    entry.status !== "offered" ||
    !entry.expires ||
    entry.expires <= now ||
    entry.offered_starts !== state.starts
  ) {
    thread.state = {};
    return "That waitlist offer has expired or is no longer available. Reply WAITLIST to join again.";
  }
  try {
    const appt = book(clinic, thread, entry.offered_starts!, `waitlist:${entry.id}:${eventKey}`, {
      source: "whatsapp",
      name: thread.name,
      contact: thread.contact,
      consent: thread.consent,
      doctorId: entry.offered_doctor_id,
      serviceId: entry.offered_service_id,
    });
    entry.status = "booked";
    entry.expires = null;
    thread.state = {};
    db.audit("patient", "waitlist.offer_accepted", entry.id, clinic.id);
    return `Confirmed: appointment #${appt.id}, ${readable(clinic, appt.starts)} with the clinic. Reception can help with any changes.`;
  } catch {
    entry.status = "expired";
    thread.state = {};
    return "Sorry, that slot was just filled. Reply WAITLIST to join again or STAFF for help.";
  }
}

function declineWaitlistOffer(clinic: Clinic, thread: Thread): string {
  const state = thread.state || {};
  const entry = db.waitlist.find((e) => e.id === state.waitlist_id);
  if (entry && entry.clinic_id === clinic.id && entry.thread_id === thread.id && entry.status === "offered") {
    entry.status = "declined";
    entry.expires = null;
    db.audit("patient", "waitlist.offer_declined", entry.id, clinic.id);
    if (entry.offered_starts) {
      offerWaitlistForSlot(clinic, entry.offered_starts, entry.offered_doctor_id, entry.offered_service_id);
    }
  }
  thread.state = {};
  return "No problem. This offer is released. Reply WAITLIST if you would like to join again.";
}

function dayFromText(text: string, clinic: Clinic): string {
  const today = localParts(clinic.timezone, nowSec()).dateStr;
  const match = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (match) {
    return parseDateStr(match[1]).iso;
  }
  if (/tomorrow|repu|రేపు|कल/i.test(text)) {
    return addDaysDateStr(today, 1);
  }
  return today;
}

function approvedFaq(clinic: Clinic, text: string): string | null {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);
  const queryWords = new Set(clean(text));
  if (queryWords.size === 0) return null;
  let bestAnswer: string | null = null;
  let bestScore = 0;
  for (const faq of clinic.faqs || []) {
    if (faq.question.trim().toLowerCase() === text.trim().toLowerCase()) {
      return faq.answer;
    }
    const qWords = clean(faq.question);
    if (!qWords.length) continue;
    const overlap = qWords.filter((w) => queryWords.has(w)).length;
    const score = overlap / Math.max(qWords.length, queryWords.size);
    if (score >= 0.5 && score > bestScore) {
      bestScore = score;
      bestAnswer = faq.answer;
    }
  }
  return bestAnswer;
}

export function answerPublicClinicQuestion(
  clinic: Clinic,
  text: string,
): { reply: string; matched: string; medical_disclaimer: boolean } {
  const t = String(text || "").trim().slice(0, 400);
  const lower = t.toLowerCase();
  if (!t) {
    return {
      reply:
        clinic.widget_greeting ||
        `Hello! Welcome to ${clinic.name}. Ask about fees, timings, address, or services—or leave your number for a callback.`,
      matched: "greeting",
      medical_disclaimer: false,
    };
  }
  if (MEDICAL.test(t)) {
    return {
      reply: `I am an automated clinic assistant and cannot give medical advice or diagnose symptoms. For an emergency, please seek immediate medical care. To speak with our clinic team, call ${clinic.phone}.`,
      matched: "medical_refusal",
      medical_disclaimer: true,
    };
  }
  if (/fee|cost|price|charge|entha|ఫీజు|ధర|शुल्क|कीमत/i.test(lower)) {
    const activeSvcs = db.services.filter((s) => s.clinic_id === clinic.id && s.active);
    const svcSummary = activeSvcs.length
      ? ` Active services: ${activeSvcs.slice(0, 5).map((s) => `${s.name} (Rs ${s.fee})`).join(", ")}.`
      : "";
    return {
      reply: `Consultation fee at ${clinic.name} is Rs ${clinic.fee}.${svcSummary} Final treatment estimates are confirmed by ${clinic.doctor} in person.`,
      matched: "fee",
      medical_disclaimer: false,
    };
  }
  if (/address|location|where|map|direction|ekkada|చిరునామా|ఎక్కడ|पता|कहाँ/i.test(lower)) {
    return {
      reply: `${clinic.name} is located at ${clinic.address}. Clinic phone: ${clinic.phone}.`,
      matched: "address",
      medical_disclaimer: false,
    };
  }
  if (/timing|hours|open|close|when|eppudu|సమయం|समय/i.test(lower)) {
    const s = clinic.schedule;
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const closedText = (s.closed_days || []).map((d) => days[d]).join(", ") || "none";
    return {
      reply: `${clinic.name} hours: ${s.open}–${s.close} (${clinic.timezone}). Closed: ${closedText}.`,
      matched: "hours",
      medical_disclaimer: false,
    };
  }
  if (/service|treatment|procedure|offer|సేవ|सेवा/i.test(lower)) {
    const activeSvcs = db.services.filter((s) => s.clinic_id === clinic.id && s.active);
    const list = activeSvcs.length
      ? activeSvcs.map((s) => `${s.name} (Rs ${s.fee})`).join(", ")
      : (clinic.services || []).join(", ");
    return {
      reply: `Approved services at ${clinic.name}: ${list || "General consultation"}.`,
      matched: "services",
      medical_disclaimer: false,
    };
  }
  if (/^(hi|hello|hey|namaste|నమస్కారం|నమస్తే|नमस्ते)\b/i.test(lower)) {
    return {
      reply:
        clinic.widget_greeting ||
        `Hello! I am ${clinic.name}’s assistant. Ask about consultation fees, clinic timings, address, or services—or book directly on WhatsApp.`,
      matched: "greeting",
      medical_disclaimer: false,
    };
  }
  const faq = approvedFaq(clinic, t);
  if (faq) {
    return {
      reply: faq,
      matched: "faq",
      medical_disclaimer: false,
    };
  }
  if (BOOKING.test(t) || TOKEN_CMD.test(t)) {
    return {
      reply: `You can book an appointment with ${clinic.doctor} right away using WhatsApp below, or leave your phone number in the callback form and reception will confirm your slot.`,
      matched: "booking_handoff",
      medical_disclaimer: false,
    };
  }
  return {
    reply: `I can answer approved questions about ${clinic.name}’s fees, timings, address, and services. For anything else, leave your number in the callback form below or call ${clinic.phone}.`,
    matched: "fallback",
    medical_disclaimer: false,
  };
}

function offerTokenSessions(clinic: Clinic, thread: Thread): string {
  const board = getQueueBoard(clinic);
  const openSessions = board.sessions.filter((s) => s.remaining_capacity > 0);
  if (!openSessions.length) {
    return `All token sessions for ${board.date} are currently full. Please reply STAFF or call ${clinic.phone}.`;
  }
  thread.state = {
    step: "choose_token_session",
    session_ids: openSessions.map((s) => s.id),
    date: board.date,
    expires: nowSec() + 900,
  };
  const lines = openSessions
    .map(
      (s, idx) =>
        `${idx + 1}. ${s.label} (${s.start}–${s.end}) · Next Token #${s.next_token} · Est. wait ~${s.estimated_wait_minutes} mins`,
    )
    .join("\n");
  return `Live queue tokens for ${clinic.name} (${board.date}):\n${lines}\nReply with a session number (e.g. 1) to get your token.`;
}

function offer(clinic: Clinic, thread: Thread, text: string, appointmentId: number | null = null): string {
  let target: string;
  try {
    target = dayFromText(text, clinic);
  } catch (e: any) {
    return e.detail || "Invalid date; use YYYY-MM-DD";
  }
  if (
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week)\b/i.test(text) &&
    !/\d{4}-\d{2}-\d{2}/.test(text)
  ) {
    return "Please send your preferred date as YYYY-MM-DD so I offer the correct day.";
  }

  const catalog = ensureCatalog(clinic);
  const doctors = catalog.doctors.filter((d) => d.active);
  const services = catalog.services.filter((s) => s.active);
  if (!doctors.length || !services.length) {
    return "Reception needs to update the available doctors or services. Reply STAFF for help.";
  }

  const state = thread.state || {};
  const old = appointmentId ? db.appointments.find((a) => a.id === appointmentId) || null : null;
  const doctorId = state.doctor_id || old?.doctor_id || null;
  const serviceId = state.service_id || old?.service_id || null;

  let selectedService: Service | undefined = services.find((s) => s.id === serviceId);
  if (!selectedService) {
    if (services.length === 1) {
      selectedService = services[0];
    } else {
      thread.state = {
        step: "choose_service",
        service_ids: services.map((s) => s.id),
        target,
        appointment_id: appointmentId,
        expires: nowSec() + 900,
      };
      const options = services.map((s, i) => `${i + 1}. ${s.name} · Rs ${s.fee}`).join("\n");
      return `Which service would you like?\n${options}\nReply with a number.`;
    }
  }

  let selectedDoctor: Doctor | undefined = doctors.find((d) => d.id === doctorId);
  if (!selectedDoctor) {
    if (doctors.length === 1) {
      selectedDoctor = doctors[0];
    } else {
      thread.state = {
        step: "choose_doctor",
        doctor_ids: doctors.map((d) => d.id),
        service_id: selectedService.id,
        target,
        appointment_id: appointmentId,
        expires: nowSec() + 900,
      };
      const options = doctors.map((d, i) => `${i + 1}. ${d.name}`).join("\n");
      return `Choose a doctor for ${selectedService.name}:\n${options}\nReply with a number.`;
    }
  }

  let slots: number[];
  try {
    slots = available(clinic, {
      targetDate: target,
      count: 3,
      exclude: appointmentId,
      demo: thread.channel === "demo",
      doctorId: selectedDoctor.id,
      serviceId: selectedService.id,
    });
  } catch (e: any) {
    return e.detail || "Unable to fetch available slots.";
  }
  if (!slots.length) {
    return "No slots are available for that date. Send another date as YYYY-MM-DD, or reply STAFF.";
  }
  thread.state = {
    step: "choose",
    slots,
    doctor_id: selectedDoctor.id,
    service_id: selectedService.id,
    expires: nowSec() + 900,
    appointment_id: appointmentId,
  };
  const choices = slots
    .map((s, i) => {
      const peak = isInWalkinWindow(clinic, selectedDoctor!, s, selectedService!.duration).matched;
      return `${i + 1}. ${readable(clinic, s)}${peak ? " (request only)" : ""}`;
    })
    .join("\n");
  return `Available with ${selectedDoctor.name} for ${selectedService.name} (${clinic.timezone}):\n${choices}\nReply 1, 2 or 3 to choose. Nothing is booked yet. Or send another date as YYYY-MM-DD.`;
}

function digitsOnly(v: string): string {
  return String(v || "").replace(/\D/g, "");
}

export function isAuthorizedStaffContact(clinic: Clinic, contact: string): boolean {
  const cDigits = digitsOnly(contact);
  if (!cDigits || !(clinic.staff_phones || []).length) return false;
  return (clinic.staff_phones || []).some((sp) => {
    const sDigits = digitsOnly(sp);
    if (!sDigits) return false;
    return sDigits === cDigits || (sDigits.length >= 10 && cDigits.endsWith(sDigits.slice(-10)));
  });
}

function parseStaffTime(
  clinic: Clinic,
  doctor: Doctor,
  dateToken: string | null,
  timeToken: string,
): { starts: number; dateStr: string } {
  const today = localParts(clinic.timezone, nowSec()).dateStr;
  let dateStr = today;
  if (dateToken) {
    if (/^tomorrow$/i.test(dateToken)) {
      dateStr = addDaysDateStr(today, 1);
    } else {
      dateStr = parseDateStr(dateToken).iso;
    }
  }
  const m = timeToken.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) {
    throw new HttpError(422, "Use a time like 10:30, 4:30pm, or 16:30");
  }
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const meridiem = m[3]?.toLowerCase() || "";
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) {
    throw new HttpError(422, "Invalid time");
  }
  if (meridiem === "pm" && hour < 12) hour += 12;
  else if (meridiem === "am" && hour === 12) hour = 0;
  else if (!meridiem && hour >= 1 && hour <= 11) {
    // Disambiguate 12h clock using clinic opening/closing hours (e.g. "4:30" -> 16:30 when open 09:00-19:00)
    const [openH, openM] = doctor.schedule.open.split(":").map(Number);
    const [closeH, closeM] = doctor.schedule.close.split(":").map(Number);
    const openMin = openH * 60 + openM;
    const closeMin = closeH * 60 + closeM;
    const rawMin = hour * 60 + minute;
    const pmMin = (hour + 12) * 60 + minute;
    if (rawMin < openMin && pmMin >= openMin && pmMin < closeMin) {
      hour += 12;
    }
  }
  const [y, mo, d] = dateStr.split("-").map(Number);
  return { starts: zonedToEpoch(clinic.timezone, y, mo, d, hour, minute, 0), dateStr };
}

export function tryStaffCommand(
  clinic: Clinic,
  contact: string,
  text: string,
  eventKey: string,
): string | null {
  if (!isAuthorizedStaffContact(clinic, contact)) return null;
  const trimmed = text.trim();
  const cmdMatch = trimmed.match(/^(block|walkin|walk-in|call|unblock|free|slots|today)\b(.*)$/i);
  if (!cmdMatch) return null;

  const cmd = cmdMatch[1].toLowerCase();
  const rest = cmdMatch[2].trim();
  const doctor = defaultDoctor(clinic);
  const service = defaultService(clinic);
  if (!doctor || !service) {
    return "Clinic needs an active doctor and service configured first.";
  }

  if (cmd === "slots" || cmd === "today") {
    const target = rest && /^\d{4}-\d{2}-\d{2}$/.test(rest) ? rest : localParts(clinic.timezone, nowSec()).dateStr;
    const free = available(clinic, { targetDate: target, count: 8, doctorId: doctor.id, serviceId: service.id });
    if (!free.length) return `No open slots left on ${target} for ${doctor.name}.`;
    return `Open slots (${doctor.name}, ${target}):\n${free.map((s) => "• " + readable(clinic, s)).join("\n")}`;
  }

  // Parse optional date ("2026-11-24" or "tomorrow") + time ("11:00", "4:30pm") + optional patient label
  const argsMatch = rest.match(
    /^(?:(\d{4}-\d{2}-\d{2}|tomorrow)\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s+(.*))?$/i,
  );
  if (!argsMatch) {
    return "Usage: BLOCK 11:00 [Patient name], WALKIN 4:30 [Name], UNBLOCK 11:00, or SLOTS.";
  }

  let parsed: { starts: number; dateStr: string };
  try {
    parsed = parseStaffTime(clinic, doctor, argsMatch[1] || null, argsMatch[2]);
  } catch (e: any) {
    return e.detail || "Could not parse time. Example: BLOCK 11:00 Ramesh";
  }

  if (cmd === "unblock" || cmd === "free") {
    const appt = db.appointments.find(
      (a) =>
        a.clinic_id === clinic.id &&
        a.doctor_id === doctor.id &&
        a.status === "confirmed" &&
        a.source !== "demo" &&
        a.starts === parsed.starts,
    );
    if (!appt) {
      return `No active booking or block found at ${readable(clinic, parsed.starts)}.`;
    }
    appt.status = "cancelled";
    cancelReminders(appt);
    offerWaitlistForSlot(clinic, appt.starts, appt.doctor_id, appt.service_id, false);
    db.audit("staff_whatsapp", "appointment.unblocked", appt.id, clinic.id);
    return `✓ Released ${readable(clinic, parsed.starts)} (${appt.name}). Slot is open for WhatsApp again.`;
  }

  const labelRaw = (argsMatch[3] || "").trim().slice(0, 100);
  const tag = cmd === "walkin" || cmd === "walk-in" ? "Walk-in" : cmd === "call" ? "Phone call" : "Desk block";
  const displayName = labelRaw ? `${labelRaw} (${tag})` : `${tag} — quick block`;

  try {
    const appt = book(clinic, null, parsed.starts, `staff-wa:${clinic.id}:${eventKey}`, {
      source: "staff",
      name: displayName,
      contact: digitsOnly(contact),
      consent: false,
      doctorId: doctor.id,
      serviceId: service.id,
    });
    db.audit("staff_whatsapp", "appointment.quick_blocked", appt.id, clinic.id);
    return `✓ Blocked ${readable(clinic, appt.starts)} (${displayName}). Removed from WhatsApp availability.`;
  } catch (e: any) {
    const nextSlots = available(clinic, {
      targetDate: parsed.dateStr,
      count: 3,
      doctorId: doctor.id,
      serviceId: service.id,
    });
    const nextText = nextSlots.length
      ? ` Next open: ${nextSlots.map((s) => readable(clinic, s)).join(", ")}.`
      : "";
    return `✕ Could not block ${readable(clinic, parsed.starts)}: ${e.detail || "Slot unavailable."}${nextText}`;
  }
}

function handleReminderAction(clinic: Clinic, thread: Thread, token: string): string {
  const actionData = verifyReminderActionToken(token);
  if (!actionData) {
    return "That reminder button is invalid or expired. Reply BOOK or STAFF for help.";
  }
  const appt = db.appointments.find((a) => a.id === actionData.appointment_id);
  const now = nowSec();
  if (
    actionData.clinic_id !== clinic.id ||
    !appt ||
    appt.clinic_id !== clinic.id ||
    appt.thread_id !== thread.id ||
    appt.contact !== thread.contact ||
    appt.starts !== actionData.starts ||
    appt.status !== "confirmed" ||
    appt.starts <= now ||
    !appt.consent ||
    !thread.consent ||
    thread.opted_out ||
    thread.channel !== "whatsapp"
  ) {
    return "That reminder is no longer active. Reply BOOK or STAFF for help.";
  }
  if (actionData.action === "confirm") {
    if (appt.reminder_response !== "confirmed") {
      appt.reminder_response = "confirmed";
      appt.reminder_response_at = now;
      db.audit("patient", "appointment.reminder_confirmed", appt.id, clinic.id);
    }
    return `Thanks. Your appointment #${appt.id} is confirmed for ${readable(clinic, appt.starts)}.`;
  }
  if (actionData.action === "reschedule") {
    appt.reminder_response = "reschedule_requested";
    appt.reminder_response_at = now;
    thread.state = {
      step: "reminder_reschedule_date",
      appointment_id: appt.id,
      expires: now + 900,
    };
    db.audit("patient", "appointment.reschedule_requested", appt.id, clinic.id);
    return "Please send your preferred date as YYYY-MM-DD. I will show available slots; nothing changes until you confirm a new time.";
  }
  appt.reminder_response = "cancellation_requested";
  appt.reminder_response_at = now;
  thread.state = {
    step: "cancel_confirm",
    appointment_id: appt.id,
    expires: now + 900,
  };
  db.audit("patient", "appointment.cancellation_requested", appt.id, clinic.id);
  return `Cancel appointment #${appt.id} on ${readable(clinic, appt.starts)}? Reply YES to cancel or NO to keep it.`;
}

function reception(
  clinic: Clinic,
  thread: Thread,
  text: string,
  eventKey: string,
  buttonPayload: string | null = null,
  isMedia = false,
): string | null {
  const t = text.trim();
  const lower = t.toLowerCase();
  const yes = ["yes", "confirm", "అవును", "అవునూ", "हाँ", "haan"].includes(lower);

  if (["stop", "unsubscribe", "ఆపు", "बंद"].includes(lower)) {
    thread.opted_out = true;
    thread.consent = false;
    thread.state = {};
    thread.generation += 1;
    releaseThreadHolds(thread.id);
    let released: [number, number | null, number | null] | null = null;
    for (const entry of db.waitlist) {
      if (entry.thread_id === thread.id && ["waiting", "offered"].includes(entry.status)) {
        if (entry.status === "offered" && entry.offered_starts) {
          released = [entry.offered_starts, entry.offered_doctor_id, entry.offered_service_id];
        }
        entry.status = "cancelled";
        entry.expires = null;
      }
    }
    if (released) {
      offerWaitlistForSlot(clinic, released[0], released[1], released[2]);
    }
    for (const job of db.jobs) {
      if (
        job.thread_id === thread.id &&
        ["pending", "retry", "dispatching"].includes(job.status) &&
        job.kind !== "inbound"
      ) {
        job.status = "cancelled";
      }
    }
    db.audit("patient", "consent.withdrawn", thread.id, clinic.id);
    onOptOut(clinic, thread);
    return OPT_OUT_ACK;
  }

  if (lower === "start") {
    thread.opted_out = false;
    return "Messages resumed. Reply BOOK to request an appointment. We will ask permission before sending reminders.";
  }
  if (thread.opted_out) return null;
  if (thread.mode === "human") return null;
  if (clinic.pilot_end && clinic.pilot_end < nowSec()) {
    takeover(thread, "Plan expired; staff review required");
    return null;
  }
  if (!clinic.enabled) {
    takeover(thread, "Automation disabled for this clinic");
    return "Your message is with reception. Please call the clinic if you need an immediate response.";
  }
  if (MEDICAL.test(t)) {
    takeover(thread, "Medical or urgent question requires staff");
    return `I am an automated receptionist and cannot give medical advice. For an emergency, seek immediate emergency care; do not wait for a WhatsApp reply. For clinic assistance call ${clinic.phone}.`;
  }
  if (HUMAN.test(t)) {
    takeover(thread, "Patient requested staff");
    return `I have placed your message in the reception queue. For immediate help, call ${clinic.phone}.`;
  }
  if (isMedia) {
    takeover(thread, "Patient sent media attachment — requires staff review");
    return `I have forwarded your message to clinic reception. For immediate help, call ${clinic.phone}.`;
  }
  if (buttonPayload) {
    return handleReminderAction(clinic, thread, buttonPayload);
  }
  if (lower.startsWith("name ")) {
    thread.name = t.slice(5).trim().slice(0, 120) || thread.name;
    return `Your booking name is now ${thread.name}. Reply BOOK or STAFF.`;
  }

  let state = thread.state || {};
  if (Object.keys(state).length && (state.expires || 0) < nowSec()) {
    releaseThreadHolds(thread.id);
    thread.state = {};
    state = {};
  }

  if (state.step === "review_rating") {
    const ratingMatch = t.match(/^\s*([1-5])(?:\s*\/\s*5|\s*stars?)?(?:\s*[-:,.]?\s*(.*))?$/i);
    if (ratingMatch) {
      const rating = Number(ratingMatch[1]);
      const note = (ratingMatch[2] || "").trim().slice(0, 500);
      const rec = db.reviews.find((r) => r.id === state.review_id && r.clinic_id === clinic.id);
      if (rec) {
        rec.rating = rating;
        rec.responded_at = nowSec();
        if (note) rec.feedback_note = note;
      }
      if (rating >= 4) {
        if (rec) rec.status = "happy_link_sent";
        thread.state = {};
        db.audit("patient", "review.positive", rec?.id ?? thread.id, clinic.id);
        const safeUrl =
          clinic.google_review_url && /^https?:\/\//i.test(clinic.google_review_url.trim())
            ? clinic.google_review_url.trim()
            : "";
        return safeUrl
          ? `Thank you for the ${rating}/5 rating! If you have 30 seconds, a quick Google review helps local patients find ${clinic.name}: ${safeUrl}`
          : `Thank you so much for the ${rating}/5 rating! We look forward to caring for you at ${clinic.name}.`;
      }
      if (rec) {
        rec.status = "escalated";
        if (!rec.feedback_note) rec.feedback_note = t.slice(0, 500);
      }
      db.audit("patient", "review.escalated", rec?.id ?? thread.id, clinic.id);
      takeover(thread, `Low visit rating (${rating}/5) — private recovery needed`, "system");
      return `Thank you for your honest feedback (${rating}/5). We are sorry your visit was not 5-star—our clinic manager has been notified privately and will reach out to make it right. You can also reply here with details.`;
    }
  }

  if (state.step === "waitlist_offer") {
    if (yes) return acceptWaitlistOffer(clinic, thread, eventKey);
    if (["no", "pass", "next"].includes(lower)) return declineWaitlistOffer(clinic, thread);
    return "Reply YES within the offer window to request this slot, or NO to pass.";
  }

  if (state.step === "waitlist_consent") {
    if (yes) {
      thread.state = {};
      if (thread.channel !== "whatsapp") {
        return "The cancellation waitlist is available to patients messaging the clinic on WhatsApp. This demo has not added you to a real waitlist.";
      }
      const entry = joinWaitlist(clinic, thread);
      if (!entry) {
        return "The cancellation waitlist is available on the Growth plan. Reply STAFF for help.";
      }
      return "You are on the cancellation waitlist. If a suitable slot opens while WhatsApp allows a message, we will send an offer that expires after 20 minutes. Reply STOP to leave.";
    }
    if (["no", "cancel"].includes(lower)) {
      thread.state = {};
      return "No problem. You have not been added to the waitlist.";
    }
    return "Reply YES to join the cancellation waitlist or NO to cancel.";
  }

  if (["waitlist", "wait list", "join waitlist"].includes(lower)) {
    if (!limitsFor(clinic).waitlist) {
      return "The cancellation waitlist is available on the Growth plan. Reply STAFF for help.";
    }
    thread.state = { step: "waitlist_consent", expires: nowSec() + 900 };
    return "Would you like to join the cancellation waitlist? We will use your contact to offer an earlier slot if one opens. Reply YES to agree or NO.";
  }

  const upcoming = db.appointments
    .filter(
      (a) =>
        a.clinic_id === clinic.id &&
        a.contact === thread.contact &&
        (thread.channel === "demo" ? a.source === "demo" : a.source !== "demo") &&
        a.status === "confirmed" &&
        a.starts > nowSec(),
    )
    .sort((a, b) => a.starts - b.starts)[0];

  if (["cancel", "cancel appointment", "రద్దు", "रद्द"].includes(lower)) {
    if (!upcoming) {
      return "No upcoming appointment was found for this contact. Reply STAFF for help.";
    }
    thread.state = {
      step: "cancel_confirm",
      appointment_id: upcoming.id,
      expires: nowSec() + 900,
    };
    return `Cancel appointment #${upcoming.id} on ${readable(clinic, upcoming.starts)}? Reply YES to cancel or NO to keep it.`;
  }

  if (/\b(reschedule|postpone|change appointment)\b/.test(lower)) {
    if (!upcoming) return "No upcoming appointment was found. Reply BOOK or STAFF.";
    return offer(clinic, thread, t, upcoming.id);
  }

  if (lower === "no" && Object.keys(state).length) {
    if (state.step === "cancel_confirm") {
      const appt = db.appointments.find((a) => a.id === state.appointment_id);
      if (appt && appt.clinic_id === clinic.id && appt.contact === thread.contact) {
        appt.reminder_response = "cancellation_declined";
        appt.reminder_response_at = nowSec();
        db.audit("patient", "appointment.cancellation_declined", appt.id, clinic.id);
      }
    }
    releaseThreadHolds(thread.id);
    thread.state = {};
    return "No change made. Reply BOOK to see availability or STAFF for help.";
  }

  if (state.step === "cancel_confirm" && yes) {
    const appt = db.appointments.find((a) => a.id === state.appointment_id);
    if (!appt || appt.clinic_id !== clinic.id || appt.contact !== thread.contact) {
      thread.state = {};
      return "Appointment could not be verified. Reply STAFF.";
    }
    appt.status = "cancelled";
    appt.reminder_response = "cancelled";
    appt.reminder_response_at = nowSec();
    cancelReminders(appt);
    offerWaitlistForSlot(clinic, appt.starts, appt.doctor_id, appt.service_id, appt.source === "demo");
    thread.state = {};
    db.audit("patient", "appointment.cancelled", appt.id, clinic.id);
    return `Appointment #${appt.id} cancelled. Reply BOOK for a new appointment.`;
  }

  if (state.step === "choose_service" && /^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    const services = (state.service_ids || []).map((id: number) => db.services.find((s) => s.id === id));
    if (idx < 0 || idx >= services.length || !services[idx] || !services[idx].active) {
      return "Please choose a displayed service number.";
    }
    thread.state = { ...state, service_id: services[idx].id };
    return offer(clinic, thread, state.target, state.appointment_id ?? null);
  }

  if (state.step === "choose_doctor" && /^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    const doctors = (state.doctor_ids || []).map((id: number) => db.doctors.find((d) => d.id === id));
    if (idx < 0 || idx >= doctors.length || !doctors[idx] || !doctors[idx].active) {
      return "Please choose a displayed doctor number.";
    }
    thread.state = { ...state, doctor_id: doctors[idx].id };
    return offer(clinic, thread, state.target, state.appointment_id ?? null);
  }

  if (state.step === "choose" && /^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    if (idx < 0 || idx >= (state.slots || []).length) {
      return "Please choose a displayed slot number.";
    }
    const starts = state.slots[idx];
    const doctor = state.doctor_id ? db.doctors.find((d) => d.id === state.doctor_id) : defaultDoctor(clinic);
    const service = state.service_id ? db.services.find((s) => s.id === state.service_id) : defaultService(clinic);
    const doctorName = doctor ? doctor.name : clinic.doctor;
    const serviceName = service ? service.name : "Consultation";
    const serviceFee = service ? service.fee : clinic.fee;

    const walkinCheck =
      doctor && service
        ? isInWalkinWindow(clinic, doctor, starts, service.duration)
        : { matched: false };

    if (!walkinCheck.matched) {
      try {
        createSlotHold(clinic, thread, starts, doctor?.id ?? null, service?.id ?? null);
      } catch {
        thread.state = {
          doctor_id: doctor?.id ?? null,
          service_id: service?.id ?? null,
        };
        const fresh = offer(clinic, thread, localParts(clinic.timezone, starts).dateStr, state.appointment_id ?? null);
        return `That slot was just taken.\n${fresh}`;
      }
    }

    thread.state = {
      ...state,
      step: "confirm",
      starts,
      walkin_request: walkinCheck.matched,
      walkin_window: walkinCheck.window || null,
      expires: nowSec() + SLOT_HOLD_SECONDS,
    };

    if (walkinCheck.matched) {
      return `Request ${readable(clinic, starts)} with ${doctorName}, ${serviceName} (Fee: Rs ${serviceFee})? This falls in our walk-in priority window (${walkinCheck.window?.start}–${walkinCheck.window?.end}), so reception will confirm availability. Reply YES to send the request or NO.`;
    }
    return `Holding ${readable(clinic, starts)} for 5 minutes while you confirm (${thread.name} · ${doctorName}, ${serviceName}, Fee: Rs ${serviceFee}). Reply YES to confirm or NO. Your name/contact are used for booking coordination. Appointment reminders will be sent on WhatsApp; reply STOP to stop messages. No medical records are requested.`;
  }

  if (state.step === "confirm" && yes) {
    const starts = state.starts;
    const oldId = state.appointment_id;

    if (state.walkin_request) {
      const doctor = state.doctor_id ? db.doctors.find((d) => d.id === state.doctor_id) : defaultDoctor(clinic);
      const service = state.service_id ? db.services.find((s) => s.id === state.service_id) : defaultService(clinic);
      const label = readable(clinic, starts);
      takeover(
        thread,
        `Walk-in priority slot request: ${label} (${doctor?.name || clinic.doctor} · ${service?.name || "Consultation"})`,
        "system",
      );
      db.audit("patient", "appointment.walkin_slot_requested", starts, clinic.id);
      return `Your request for ${label} (walk-in priority window) has been sent to reception. Our desk will confirm your slot or suggest the nearest time shortly.`;
    }

    let appt;
    try {
      thread.consent = true;
      if (oldId) {
        appt = db.appointments.find((a) => a.id === oldId);
        if (!appt || appt.clinic_id !== clinic.id || appt.contact !== thread.contact || appt.status !== "confirmed") {
          throw new HttpError(409, "Original appointment is no longer active");
        }
        appt.consent = true;
        const oldStarts = appt.starts;
        reschedule(clinic, appt, starts);
        releaseThreadHolds(thread.id);
        appt.reminder_response = "rescheduled";
        appt.reminder_response_at = nowSec();
        offerWaitlistForSlot(clinic, oldStarts, appt.doctor_id, appt.service_id, appt.source === "demo");
        db.audit("patient", "appointment.rescheduled", appt.id, clinic.id);
      } else {
        appt = book(clinic, thread, starts, `confirm:${clinic.id}:${eventKey}`, {
          source: thread.channel === "demo" ? "demo" : "whatsapp",
          doctorId: state.doctor_id ?? null,
          serviceId: state.service_id ?? null,
        });
      }
    } catch {
      releaseThreadHolds(thread.id);
      thread.state = {};
      return "That slot is no longer available. Reply BOOK to choose again. Nothing new was booked.";
    }
    thread.state = {};
    const doctor = appt.doctor_id ? db.doctors.find((d) => d.id === appt.doctor_id) : null;
    const service = appt.service_id ? db.services.find((s) => s.id === appt.service_id) : null;
    return `Confirmed: appointment #${appt.id}, ${readable(clinic, appt.starts)}, ${doctor ? doctor.name : clinic.doctor} · ${service ? service.name : "Consultation"}. Address: ${clinic.address}. Reply CANCEL or RESCHEDULE if needed.`;
  }

  if (state.step === "choose_token_session" && /^\d+$/.test(t)) {
    const idx = Number(t) - 1;
    const sessionIds: string[] = Array.isArray(state.session_ids) ? state.session_ids : [];
    if (idx < 0 || idx >= sessionIds.length) {
      return "Please reply with a displayed session number (e.g. 1).";
    }
    try {
      const issued = issueQueueToken(clinic, {
        date: state.date || null,
        session_id: sessionIds[idx],
        patient_name: thread.name,
        contact: thread.contact,
        source: thread.channel === "demo" ? "demo" : "whatsapp",
        thread_id: thread.id,
        actor: "patient",
      });
      thread.consent = true;
      thread.state = {};
      return `Confirmed: Token #${issued.token.token_number} for ${issued.session.label} (${issued.session.start}–${issued.session.end}) on ${issued.token.date}. Estimated wait: ~${issued.estimated_wait_minutes} mins. Address: ${clinic.address}.`;
    } catch (e: any) {
      thread.state = {};
      return `${e?.detail || "Could not issue token for that session."} Reply TOKEN to try another session or STAFF for help.`;
    }
  }

  if (TOKEN_CMD.test(t) && (clinic.booking_mode === "tokens" || clinic.booking_mode === "hybrid")) {
    return offerTokenSessions(clinic, thread);
  }

  if (BOOKING.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t)) {
    if (clinic.booking_mode === "tokens" && !state.appointment_id && !/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return offerTokenSessions(clinic, thread);
    }
    if (upcoming && !state.appointment_id) {
      return `You already have appointment #${upcoming.id} on ${readable(clinic, upcoming.starts)}. Reply RESCHEDULE, CANCEL or STAFF.`;
    }
    return offer(clinic, thread, t, state.appointment_id ?? null);
  }

  if (state.step === "confirm") {
    return "Reply YES to confirm the displayed appointment, NO to keep it unbooked, or STAFF.";
  }
  if (state.step === "choose") {
    return "Reply with a displayed slot number, send a date as YYYY-MM-DD, or reply STAFF.";
  }
  if (state.step === "choose_token_session") {
    return "Reply with a displayed session number (e.g. 1) to get your queue token, or reply STAFF.";
  }
  if (/fee|cost|price|entha|ఫీజు|ధర|शुल्क|कीमत/i.test(lower)) {
    return `Consultation fee is Rs ${clinic.fee}. Treatment prices require clinic confirmation. Reply BOOK or STAFF.`;
  }
  if (/address|location|where|ekkada|చిరునామా|ఎక్కడ|पता|कहाँ/i.test(lower)) {
    return `${clinic.name}: ${clinic.address}. Phone: ${clinic.phone}.`;
  }
  if (/timing|hours|open|close|eppudu|సమయం|समय/i.test(lower)) {
    const s = clinic.schedule;
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const closedText = (s.closed_days || []).map((d) => days[d]).join(", ") || "none";
    return `${clinic.name}: ${s.open}–${s.close} (${clinic.timezone}). Closed: ${closedText}. Reply BOOK for actual availability.`;
  }
  if (/service|treatment|సేవ|सेवा/i.test(lower)) {
    return `Clinic-approved services: ${(clinic.services || []).join(", ")}. Reply STAFF for treatment questions.`;
  }
  if (["hi", "hello", "hey", "నమస్కారం", "నమస్తే", "नमस्ते"].includes(lower)) {
    return `Hello! I am ${clinic.name}’s automated receptionist. Reply BOOK for appointments, FEES, HOURS, ADDRESS or STAFF. For date selection send YYYY-MM-DD.`;
  }

  const answer = approvedFaq(clinic, t);
  if (answer) return answer;

  takeover(thread, "Question outside approved clinic information");
  return `I have placed this question in the reception queue. Call ${clinic.phone} for immediate help.`;
}

export function inbound(
  clinic: Clinic,
  contact: string,
  name: string,
  text: string,
  eventKey: string,
  options: {
    channel?: "whatsapp" | "demo";
    providerId?: string | null;
    receivedAt?: number | null;
    buttonPayload?: string | null;
    isMedia?: boolean;
  } = {},
): { thread: Thread; reply: string | null } {
  const {
    channel = "whatsapp",
    providerId = null,
    receivedAt = null,
    buttonPayload = null,
    isMedia = false,
  } = options;
  const thread = getThread(clinic, contact, name, channel);
  if (providerId && db.messages.some((m) => m.provider_id === providerId)) {
    return { thread, reply: null };
  }
  const now = nowSec();
  thread.last_inbound = Math.max(thread.last_inbound, Math.min(receivedAt || now, now));
  thread.updated = now;
  db.messages.push({
    id: db.nextId("messages"),
    thread_id: thread.id,
    direction: "in",
    text,
    provider_id: providerId,
    status: "received",
    created: now,
  });

  // Authorized staff WhatsApp command shortcut (e.g., "BLOCK 11:00 Ramesh", "WALKIN 4:30", "UNBLOCK 11:00", "SLOTS")
  const staffReply = tryStaffCommand(clinic, contact, text, eventKey);
  if (staffReply) {
    queueReply(clinic, thread, staffReply, `reply:${clinic.id}:${eventKey}`, "system");
    return { thread, reply: staffReply };
  }

  trackWhatsApp(clinic, thread);
  const reply = reception(clinic, thread, text, eventKey, buttonPayload, isMedia);
  if (reply) {
    queueReply(
      clinic,
      thread,
      reply,
      `reply:${clinic.id}:${eventKey}`,
      thread.mode === "human" ? "system" : "bot",
    );
  }
  return { thread, reply };
}
