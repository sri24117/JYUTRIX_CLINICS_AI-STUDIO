import { Appointment, Clinic, Enquiry, HttpError, Thread, db, nowSec } from "./store.js";
import { addDaysDateStr, localParts, zonedToEpoch } from "./booking.js";

export const STATUSES = ["new", "contacted", "interested", "booked", "lost"] as const;
export const OPEN_STATUSES = ["new", "contacted", "interested"] as const;
export const SOURCES = ["whatsapp", "website", "phone", "walk_in"] as const;

export const OUTCOMES: Record<string, string> = {
  reached: "Spoke to patient",
  interested: "Spoke to patient, interested",
  no_answer: "No answer",
  snooze: "Snoozed",
  lost: "Marked lost",
};

const MAX_EVENTS = 200;
const QUEUE_LIMIT = 500;
export const BOOKING_CREATED = "Created from a booking";

export function businessTime(clinic: Clinic, ts: number): number {
  const tz = clinic.timezone;
  const schedule = clinic.schedule;
  const [openH, openM] = schedule.open.split(":").map(Number);
  const [closeH, closeM] = schedule.close.split(":").map(Number);

  let currentTs = ts;
  for (let i = 0; i < 30; i++) {
    const lp = localParts(tz, currentTs);
    const opens = zonedToEpoch(tz, lp.year, lp.month, lp.day, openH, openM, 0);
    const closes = zonedToEpoch(tz, lp.year, lp.month, lp.day, closeH, closeM, 0);
    const closed =
      (schedule.closed_days || []).includes(lp.weekday) ||
      (schedule.leave_dates || []).includes(lp.dateStr);
    if (!closed) {
      if (currentTs < opens) return opens;
      if (currentTs < closes) return currentTs;
    }
    const nextDate = addDaysDateStr(lp.dateStr, 1);
    const [ny, nm, nd] = nextDate.split("-").map(Number);
    currentTs = zonedToEpoch(tz, ny, nm, nd, openH, openM, 0);
  }
  return Math.floor(ts);
}

export function defaultDue(clinic: Clinic, now: number): number {
  return businessTime(clinic, now + (clinic.followup_hours || 4) * 3600);
}

export function isDirect(enquiry: Enquiry): boolean {
  return (enquiry.events || []).some(
    (e) => e.type === "created" && e.text === BOOKING_CREATED,
  );
}

export function addEvent(
  enquiry: Enquiry,
  kind: string,
  text: string,
  actor: string,
  extra: { outcome?: string } = {},
): void {
  const event = { t: nowSec(), type: kind, actor, text, ...extra };
  enquiry.events = [...(enquiry.events || []), event].slice(-MAX_EVENTS);
}

export function findEnquiry(clinicId: number, contact: string): Enquiry | null {
  return db.enquiries.find((e) => e.clinic_id === clinicId && e.contact === contact) || null;
}

function createEnquiryRecord(
  clinic: Clinic,
  name: string,
  contact: string,
  source: Enquiry["source"],
  now: number,
  followup = true,
): Enquiry {
  const enquiry: Enquiry = {
    id: db.nextId("enquiries"),
    clinic_id: clinic.id,
    thread_id: null,
    appointment_id: null,
    name,
    contact,
    source,
    status: "new",
    service_interest: "",
    assigned_to: null,
    next_followup: followup ? defaultDue(clinic, now) : null,
    events: [],
    last_activity: now,
    created: now,
  };
  db.enquiries.push(enquiry);
  return enquiry;
}

export function trackWhatsApp(clinic: Clinic, thread: Thread): Enquiry | null {
  if (thread.channel !== "whatsapp") return null;
  const now = nowSec();
  let enquiry = findEnquiry(clinic.id, thread.contact);
  if (!enquiry) {
    enquiry = createEnquiryRecord(clinic, thread.name, thread.contact, "whatsapp", now);
    addEvent(enquiry, "created", "First WhatsApp message", "patient");
  }
  enquiry.thread_id = thread.id;
  enquiry.name = thread.name;
  enquiry.last_activity = now;
  if (enquiry.status === "lost") {
    enquiry.status = "new";
    enquiry.next_followup = thread.opted_out ? null : defaultDue(clinic, now);
    addEvent(enquiry, "status", "lost → new (patient messaged again)", "patient");
  }
  return enquiry;
}

export function recordBooking(clinic: Clinic, appt: Appointment, thread: Thread | null = null): Enquiry | null {
  if (appt.source === "demo") return null;
  const now = nowSec();
  let enquiry = findEnquiry(clinic.id, appt.contact);
  if (!enquiry) {
    enquiry = createEnquiryRecord(
      clinic,
      appt.name,
      appt.contact,
      thread ? "whatsapp" : "phone",
      now,
      false,
    );
    addEvent(enquiry, "created", BOOKING_CREATED, appt.source);
  }
  if (thread && !enquiry.thread_id) {
    enquiry.thread_id = thread.id;
  }
  const previous = enquiry.status;
  enquiry.status = "booked";
  enquiry.appointment_id = appt.id;
  enquiry.next_followup = null;
  enquiry.last_activity = now;
  addEvent(enquiry, "status", `${previous} → booked (appointment #${appt.id})`, appt.source);
  return enquiry;
}

export function createManualEnquiry(
  clinic: Clinic,
  payload: { name: string; contact: string; source: Enquiry["source"]; service_interest?: string; note?: string },
  actor: string,
): { enquiry: Enquiry; created: boolean } {
  const now = nowSec();
  const contact = payload.contact.replace(/^\+/, "");
  let enquiry = findEnquiry(clinic.id, contact);
  const created = !enquiry;
  if (!enquiry) {
    const thread = db.threads.find(
      (t) => t.clinic_id === clinic.id && t.contact === contact && t.channel === "whatsapp",
    );
    enquiry = createEnquiryRecord(clinic, payload.name, contact, payload.source, now);
    enquiry.thread_id = thread ? thread.id : null;
    addEvent(enquiry, "created", `Added by staff (${payload.source})`, actor);
  }
  if (payload.service_interest) enquiry.service_interest = payload.service_interest;
  if (payload.note) addEvent(enquiry, "note", payload.note, actor);
  enquiry.last_activity = now;
  return { enquiry, created };
}

export function onOptOut(clinic: Clinic, thread: Thread): void {
  const enquiry = findEnquiry(clinic.id, thread.contact);
  if (enquiry && (OPEN_STATUSES as readonly string[]).includes(enquiry.status) && enquiry.next_followup !== null) {
    enquiry.next_followup = null;
    addEvent(enquiry, "followup", "Patient sent STOP; follow-up cleared", "patient", { outcome: "stop" });
  }
}

export function applyFollowup(
  clinic: Clinic,
  enquiry: Enquiry,
  outcome: string,
  days: number | null | undefined,
  note: string,
  actor: string,
): void {
  if (!(OPEN_STATUSES as readonly string[]).includes(enquiry.status)) {
    throw new HttpError(409, `This enquiry is already ${enquiry.status}`);
  }
  if (!OUTCOMES[outcome]) {
    throw new HttpError(422, "Unknown follow-up outcome");
  }
  const now = nowSec();
  const later = (n: number) => businessTime(clinic, now + n * 86400);
  let newStatus: Enquiry["status"] | null =
    outcome === "reached"
      ? "contacted"
      : outcome === "interested"
        ? "interested"
        : outcome === "lost"
          ? "lost"
          : null;
  if (outcome === "reached" && enquiry.status !== "new") {
    newStatus = null;
  }
  if (newStatus && newStatus !== enquiry.status) {
    addEvent(enquiry, "status", `${enquiry.status} → ${newStatus}`, actor);
    enquiry.status = newStatus;
  }
  if (outcome === "lost") {
    enquiry.next_followup = null;
  } else if (outcome === "no_answer") {
    enquiry.next_followup = days ? later(days) : defaultDue(clinic, now);
  } else if (outcome === "snooze") {
    if (!days) throw new HttpError(422, "Choose when to be reminded");
    enquiry.next_followup = later(days);
  } else {
    enquiry.next_followup = days ? later(days) : null;
  }
  const label = OUTCOMES[outcome];
  addEvent(enquiry, "followup", note ? `${label}: ${note}` : label, actor, { outcome });
  enquiry.last_activity = now;
  db.audit(actor, "enquiry.followup_logged", enquiry.id, clinic.id);
}

export function asEnquiryDict(enquiry: Enquiry, now?: number) {
  const ts = now || nowSec();
  return {
    id: enquiry.id,
    thread_id: enquiry.thread_id,
    appointment_id: enquiry.appointment_id,
    name: enquiry.name,
    contact: enquiry.contact,
    source: enquiry.source,
    status: enquiry.status,
    service_interest: enquiry.service_interest,
    assigned_to: enquiry.assigned_to,
    next_followup: enquiry.next_followup,
    overdue: Boolean(
      (OPEN_STATUSES as readonly string[]).includes(enquiry.status) &&
        enquiry.next_followup &&
        enquiry.next_followup <= ts,
    ),
    last_activity: enquiry.last_activity,
    created: enquiry.created,
    no_answers: (enquiry.events || []).filter((e) => e.outcome === "no_answer").length,
    events: enquiry.events || [],
  };
}

export function followupQueue(clinic: Clinic, nowInput?: number) {
  const now = Math.floor(nowInput || nowSec());
  const lp = localParts(clinic.timezone, now);
  const tomorrowStr = addDaysDateStr(lp.dateStr, 1);
  const [ty, tm, td] = tomorrowStr.split("-").map(Number);
  const endToday = zonedToEpoch(clinic.timezone, ty, tm, td, 0, 0, 0);

  const open = db.enquiries.filter(
    (e) => e.clinic_id === clinic.id && (OPEN_STATUSES as readonly string[]).includes(e.status),
  );

  const overdue = open
    .filter((e) => e.next_followup !== null && e.next_followup <= now)
    .sort((a, b) => (a.next_followup || 0) - (b.next_followup || 0))
    .slice(0, QUEUE_LIMIT);

  const todayRows = open
    .filter((e) => e.next_followup !== null && e.next_followup > now && e.next_followup < endToday)
    .sort((a, b) => (a.next_followup || 0) - (b.next_followup || 0))
    .slice(0, QUEUE_LIMIT);

  const unscheduled = open
    .filter((e) => {
      if (e.next_followup !== null) return false;
      if (!e.thread_id) return true;
      const thread = db.threads.find((t) => t.id === e.thread_id);
      return !thread || !thread.opted_out;
    })
    .sort((a, b) => b.last_activity - a.last_activity)
    .slice(0, QUEUE_LIMIT);

  const upcoming = open.filter((e) => e.next_followup !== null && e.next_followup >= endToday).length;

  return {
    overdue: overdue.map((e) => asEnquiryDict(e, now)),
    today: todayRows.map((e) => asEnquiryDict(e, now)),
    unscheduled: unscheduled.map((e) => asEnquiryDict(e, now)),
    counts: {
      overdue: overdue.length,
      today: todayRows.length,
      unscheduled: unscheduled.length,
      upcoming,
    },
    followup_hours: clinic.followup_hours,
  };
}
