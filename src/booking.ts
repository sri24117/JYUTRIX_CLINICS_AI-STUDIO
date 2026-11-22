import {
  Appointment,
  Clinic,
  Doctor,
  HttpError,
  Service,
  Thread,
  db,
  ensureCatalog,
  limitsFor,
  nowSec,
} from "./store.js";
import { recordBooking } from "./enquiries.js";

export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Mon, 1 = Tue, ..., 6 = Sun (matches Python datetime.weekday()) */
  weekday: number;
  dateStr: string;
}

const WEEKDAY_MAP: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export function localParts(tz: string, epochSec: number): LocalParts {
  const date = new Date(epochSec * 1000);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  const weekday = WEEKDAY_MAP[parts.weekday] ?? 0;
  const dateStr = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, hour, minute, second, weekday, dateStr };
}

/** Convert wall-clock date/time in a given IANA timezone to Unix epoch seconds. */
export function zonedToEpoch(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const lp = localParts(tz, Math.floor(guessMs / 1000));
  const actualMs = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, lp.second);
  let epoch = Math.floor((guessMs + (guessMs - actualMs)) / 1000);
  // One refinement pass for DST boundaries
  const lp2 = localParts(tz, epoch);
  const actualMs2 = Date.UTC(lp2.year, lp2.month - 1, lp2.day, lp2.hour, lp2.minute, lp2.second);
  if (actualMs2 !== guessMs) {
    epoch += Math.floor((guessMs - actualMs2) / 1000);
  }
  return epoch;
}

export function addDaysDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function parseDateStr(value: string): { year: number; month: number; day: number; iso: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(422, "Use YYYY-MM-DD");
  }
  const [year, month, day] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new HttpError(422, "Invalid date; use YYYY-MM-DD");
  }
  return { year, month, day, iso: value };
}

export function diffDays(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

export function readable(clinic: Clinic, stamp: number): string {
  const d = new Date(stamp * 1000);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: clinic.timezone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

export function toLocalIso(clinic: Clinic, stamp: number): string {
  const lp = localParts(clinic.timezone, stamp);
  const utcMs = stamp * 1000;
  const wallMs = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, lp.second);
  const offsetMin = Math.round((wallMs - utcMs) / 60000);
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const oh = String(Math.floor(absMin / 60)).padStart(2, "0");
  const om = String(absMin % 60).padStart(2, "0");
  return `${lp.dateStr}T${String(lp.hour).padStart(2, "0")}:${String(lp.minute).padStart(2, "0")}:${String(lp.second).padStart(2, "0")}${sign}${oh}:${om}`;
}

export function asStamp(value: string, clinic: Clinic): number {
  if (!value || typeof value !== "string") {
    throw new HttpError(422, "Use an ISO date and time");
  }
  const hasTz = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
  if (hasTz) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) throw new HttpError(422, "Use an ISO date and time");
    return Math.floor(ms / 1000);
  }
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new HttpError(422, "Use an ISO date and time");
  return zonedToEpoch(
    clinic.timezone,
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0),
  );
}

export function defaultDoctor(clinic: Clinic): Doctor | null {
  const { doctors } = ensureCatalog(clinic);
  return doctors.find((d) => d.active) || null;
}

export function defaultService(clinic: Clinic): Service | null {
  const { services } = ensureCatalog(clinic);
  return services.find((s) => s.active) || null;
}

function hhmmToMins(x: string): number {
  const [h, m] = x.split(":").map(Number);
  return h * 60 + m;
}

export function checkSlot(
  clinic: Clinic,
  starts: number,
  options: { exclude?: number | null; demo?: boolean; doctorId?: number | null; serviceId?: number | null } = {},
): number {
  const { exclude = null, demo = false, doctorId = null, serviceId = null } = options;
  if (starts <= nowSec()) {
    throw new HttpError(409, "Choose a future appointment");
  }
  const { doctors, services } = ensureCatalog(clinic);
  const doctor = doctorId
    ? db.doctors.find((d) => d.id === doctorId) || null
    : doctors.find((d) => d.active) || null;
  const service = serviceId
    ? db.services.find((s) => s.id === serviceId) || null
    : services.find((s) => s.active) || null;

  if (!doctor || doctor.clinic_id !== clinic.id || !doctor.active) {
    throw new HttpError(422, "Choose an active doctor for this clinic");
  }
  if (!service || service.clinic_id !== clinic.id || !service.active) {
    throw new HttpError(422, "Choose an active service for this clinic");
  }

  const dt = localParts(clinic.timezone, starts);
  const schedule = doctor.schedule;
  if (
    (schedule.closed_days || []).includes(dt.weekday) ||
    (schedule.leave_dates || []).includes(dt.dateStr)
  ) {
    throw new HttpError(409, `${doctor.name} is unavailable on this date`);
  }

  const minutes = dt.hour * 60 + dt.minute;
  const opening = hhmmToMins(schedule.open);
  const closing = hhmmToMins(schedule.close);
  const duration = service.duration;

  if (
    dt.second !== 0 ||
    minutes < opening ||
    minutes + duration > closing ||
    (minutes - opening) % duration !== 0
  ) {
    throw new HttpError(409, "Choose a slot aligned with doctor hours and service duration");
  }

  for (const gap of schedule.breaks || []) {
    if (gap.start && gap.end && minutes < hhmmToMins(gap.end) && minutes + duration > hhmmToMins(gap.start)) {
      throw new HttpError(409, "Appointment overlaps doctor break");
    }
  }

  const ends = starts + duration * 60;
  const conflict = db.appointments.find(
    (a) =>
      a.clinic_id === clinic.id &&
      a.doctor_id === doctor.id &&
      a.status === "confirmed" &&
      (demo ? a.source === "demo" : a.source !== "demo") &&
      a.starts < ends &&
      a.ends > starts &&
      (exclude == null || a.id !== exclude),
  );
  if (conflict) {
    throw new HttpError(409, "Slot just filled. Choose another time.");
  }
  return ends;
}

export function available(
  clinic: Clinic,
  options: {
    targetDate?: string | null;
    count?: number;
    exclude?: number | null;
    demo?: boolean;
    doctorId?: number | null;
    serviceId?: number | null;
  } = {},
): number[] {
  const { targetDate = null, count = 6, exclude = null, demo = false, doctorId = null, serviceId = null } = options;
  const { doctors, services } = ensureCatalog(clinic);
  const doctor = doctorId
    ? db.doctors.find((d) => d.id === doctorId) || null
    : doctors.find((d) => d.active) || null;
  const service = serviceId
    ? db.services.find((s) => s.id === serviceId) || null
    : services.find((s) => s.active) || null;

  if (!doctor || doctor.clinic_id !== clinic.id || !doctor.active) {
    throw new HttpError(422, "Choose an active doctor for this clinic");
  }
  if (!service || service.clinic_id !== clinic.id || !service.active) {
    throw new HttpError(422, "Choose an active service for this clinic");
  }

  const today = localParts(clinic.timezone, nowSec()).dateStr;
  const target = targetDate ? parseDateStr(targetDate).iso : today;
  const delta = diffDays(today, target);
  if (delta < 0 || delta > 60) {
    throw new HttpError(422, "Choose a date within the next 60 days");
  }

  const result: number[] = [];
  const daysToScan = target === today ? 14 : 1;
  const opening = hhmmToMins(doctor.schedule.open);
  const closing = hhmmToMins(doctor.schedule.close);

  for (let offset = 0; offset < daysToScan; offset++) {
    const dayStr = addDaysDateStr(target, offset);
    const [y, m, d] = dayStr.split("-").map(Number);
    for (let mins = opening; mins + service.duration <= closing; mins += service.duration) {
      const stamp = zonedToEpoch(clinic.timezone, y, m, d, Math.floor(mins / 60), mins % 60, 0);
      try {
        checkSlot(clinic, stamp, { exclude, demo, doctorId: doctor.id, serviceId: service.id });
        result.push(stamp);
        if (result.length >= count) return result;
      } catch {
        // skip unavailable slot
      }
    }
  }
  return result;
}

export function reminderJobs(clinic: Clinic, appt: Appointment, thread: Thread | null): void {
  if (!thread || thread.channel !== "whatsapp" || !appt.consent) return;
  for (const hours of limitsFor(clinic).reminder_offsets_hours) {
    const due = appt.starts - hours * 3600;
    if (due <= nowSec()) continue;
    const key = `reminder:${appt.id}:${appt.starts}:${hours}`;
    if (db.jobs.some((j) => j.key === key)) continue;
    db.jobs.push({
      id: db.nextId("jobs"),
      clinic_id: clinic.id,
      thread_id: thread.id,
      appointment_id: appt.id,
      key,
      kind: "reminder",
      status: "pending",
      attempts: 0,
      due,
      error: "",
      message_id: null,
      payload: { starts: appt.starts },
      created: nowSec(),
    });
  }
}

export function cancelReminders(appt: Appointment): void {
  for (const job of db.jobs) {
    if (job.appointment_id === appt.id && ["pending", "retry", "dispatching"].includes(job.status)) {
      job.status = "cancelled";
    }
  }
}

export function book(
  clinic: Clinic,
  thread: Thread | null,
  starts: number,
  requestKey: string,
  options: {
    source?: "whatsapp" | "staff" | "demo";
    name?: string | null;
    contact?: string | null;
    consent?: boolean;
    doctorId?: number | null;
    serviceId?: number | null;
  } = {},
): Appointment {
  const {
    source = "whatsapp",
    name = null,
    contact = null,
    consent = false,
    doctorId = null,
    serviceId = null,
  } = options;

  const existing = db.appointments.find(
    (a) => a.clinic_id === clinic.id && a.request_key === requestKey,
  );
  if (existing) return existing;

  const doctor = doctorId
    ? db.doctors.find((d) => d.id === doctorId) || null
    : defaultDoctor(clinic);
  const service = serviceId
    ? db.services.find((s) => s.id === serviceId) || null
    : defaultService(clinic);
  if (!doctor || !service) {
    throw new HttpError(409, "Clinic needs an active doctor and service");
  }

  const ends = checkSlot(clinic, starts, {
    demo: source === "demo",
    doctorId: doctor.id,
    serviceId: service.id,
  });

  const appt: Appointment = {
    id: db.nextId("appointments"),
    clinic_id: clinic.id,
    doctor_id: doctor.id,
    service_id: service.id,
    service_fee: service.fee,
    thread_id: thread ? thread.id : null,
    name: name || thread?.name || "Patient",
    contact: contact || thread?.contact || "",
    starts,
    ends,
    status: "confirmed",
    source,
    request_key: requestKey,
    consent: consent || Boolean(thread && thread.consent),
    paid_amount: 0,
    reminder_response: "pending",
    reminder_response_at: null,
    created: nowSec(),
  };
  db.appointments.push(appt);
  reminderJobs(clinic, appt, thread);
  db.audit(source, "appointment.created", appt.id, clinic.id);
  recordBooking(clinic, appt, thread);
  return appt;
}

export function reschedule(
  clinic: Clinic,
  appt: Appointment,
  starts: number,
  doctorId: number | null = null,
  serviceId: number | null = null,
): void {
  const targetDoctor = doctorId ?? appt.doctor_id;
  const targetService = serviceId ?? appt.service_id;
  const ends = checkSlot(clinic, starts, {
    exclude: appt.id,
    demo: appt.source === "demo",
    doctorId: targetDoctor,
    serviceId: targetService,
  });
  cancelReminders(appt);
  if (targetService !== appt.service_id) {
    const selectedService = db.services.find((s) => s.id === targetService);
    appt.service_fee = selectedService ? selectedService.fee : clinic.fee;
  }
  appt.starts = starts;
  appt.ends = ends;
  appt.reminder_response = "pending";
  appt.reminder_response_at = null;
  appt.doctor_id = targetDoctor;
  appt.service_id = targetService;
  const thread = appt.thread_id ? db.threads.find((t) => t.id === appt.thread_id) || null : null;
  reminderJobs(clinic, appt, thread);
}
