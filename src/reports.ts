import { Appointment, Clinic, HttpError, db, nowSec } from "./store.js";
import { addDaysDateStr, diffDays, localParts, parseDateStr, zonedToEpoch } from "./booking.js";
import { OPEN_STATUSES, SOURCES, isDirect } from "./enquiries.js";

const PERIODS = ["today", "7d", "30d", "month", "all", "custom"] as const;
const LABELS: Record<string, string> = {
  today: "Today",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  month: "This month",
  all: "All time",
};

const MAX_CUSTOM_DAYS = 366;
const MAX_SERIES_DAYS = 92;
const DEFINITION =
  "Operational counts for live (non-demo) data in the clinic's time zone. " +
  "Enquiries are people who contacted the clinic in the period; conversion is the share " +
  "of them who have a booking today. Phone or walk-in bookings made for people who never " +
  "enquired are counted as bookings, not as converted enquiries. Attendance covers visits " +
  "in the period with a recorded outcome. These figures do not prove the software caused any booking.";

function pct(part: number, whole: number): number | null {
  return whole ? Math.round((part * 1000) / whole) / 10 : null;
}

function midnightEpoch(dateStr: string, tz: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return zonedToEpoch(tz, y, m, d, 0, 0, 0);
}

export interface PeriodWindow {
  key: string;
  label: string;
  start: number | null;
  end: number | null;
  days: number | null;
  first: string | null;
  last: string | null;
}

export function resolvePeriod(
  clinic: Clinic,
  period: string,
  start?: string | null,
  end?: string | null,
  nowInput?: number,
): PeriodWindow {
  if (!(PERIODS as readonly string[]).includes(period)) {
    throw new HttpError(422, "Unknown period");
  }
  const tz = clinic.timezone;
  const today = localParts(tz, nowInput || nowSec()).dateStr;
  if (period === "all") {
    return { key: "all", label: LABELS.all, start: null, end: null, days: null, first: null, last: null };
  }
  let first: string;
  let last: string;
  let label: string;
  if (period === "custom") {
    try {
      first = parseDateStr(start || "").iso;
      last = parseDateStr(end || "").iso;
    } catch {
      throw new HttpError(422, "Custom ranges need start and end dates as YYYY-MM-DD");
    }
    if (first > last) {
      throw new HttpError(422, "The start date must not be after the end date");
    }
    if (diffDays(first, last) + 1 > MAX_CUSTOM_DAYS) {
      throw new HttpError(422, `Choose a range of at most ${MAX_CUSTOM_DAYS} days`);
    }
    label = `${first} to ${last}`;
  } else {
    last = today;
    if (period === "today") first = today;
    else if (period === "7d") first = addDaysDateStr(today, -6);
    else if (period === "30d") first = addDaysDateStr(today, -29);
    else first = `${today.slice(0, 7)}-01`;
    label = LABELS[period];
  }
  return {
    key: period,
    label,
    start: midnightEpoch(first, tz),
    end: midnightEpoch(addDaysDateStr(last, 1), tz),
    days: diffDays(first, last) + 1,
    first,
    last,
  };
}

function within(ts: number, p: PeriodWindow): boolean {
  if (p.start === null || p.end === null) return true;
  return ts >= p.start && ts < p.end;
}

function breakdown(visits: Appointment[], names: Map<number | null, string>, key: "doctor_id" | "service_id") {
  const rows = new Map<
    number | null,
    {
      id: number | null;
      name: string;
      booked: number;
      attended: number;
      no_shows: number;
      cancelled: number;
      recorded_payments: number;
    }
  >();
  for (const a of visits) {
    const id = a[key];
    let item = rows.get(id);
    if (!item) {
      item = {
        id,
        name: names.get(id) || "Unassigned",
        booked: 0,
        attended: 0,
        no_shows: 0,
        cancelled: 0,
        recorded_payments: 0,
      };
      rows.set(id, item);
    }
    item.booked += a.status !== "cancelled" ? 1 : 0;
    item.attended += a.status === "completed" ? 1 : 0;
    item.no_shows += a.status === "no_show" ? 1 : 0;
    item.cancelled += a.status === "cancelled" ? 1 : 0;
    item.recorded_payments += a.paid_amount || 0;
  }
  return [...rows.values()].sort((a, b) => b.booked - a.booked || a.name.localeCompare(b.name));
}

export function performanceReport(clinic: Clinic, p: PeriodWindow, nowInput?: number) {
  const now = Math.floor(nowInput || nowSec());
  const tz = clinic.timezone;
  const cid = clinic.id;

  const enquiries = db.enquiries.filter((e) => e.clinic_id === cid && within(e.created, p));
  const direct = enquiries.filter((e) => isDirect(e));
  const cohort = enquiries.filter((e) => !isDirect(e));
  const booked = cohort.filter((e) => e.status === "booked");

  const by_source = SOURCES.map((source) => {
    const rows = cohort.filter((e) => e.source === source);
    const done = rows.filter((e) => e.status === "booked").length;
    return { source, enquiries: rows.length, booked: done, conversion_rate: pct(done, rows.length) };
  });

  const overdueCount = db.enquiries.filter(
    (e) =>
      e.clinic_id === cid &&
      (OPEN_STATUSES as readonly string[]).includes(e.status) &&
      e.next_followup !== null &&
      e.next_followup <= now,
  ).length;

  const made = db.appointments.filter(
    (a) => a.clinic_id === cid && a.source !== "demo" && within(a.created, p),
  );
  const visits = db.appointments.filter(
    (a) => a.clinic_id === cid && a.source !== "demo" && within(a.starts, p),
  );

  const attended = visits.filter((a) => a.status === "completed").length;
  const no_shows = visits.filter((a) => a.status === "no_show").length;
  const confirmed = visits.filter((a) => a.status === "confirmed");
  const attendance = {
    attended,
    no_shows,
    cancelled: visits.filter((a) => a.status === "cancelled").length,
    upcoming: confirmed.filter((a) => a.starts > now).length,
    unrecorded: confirmed.filter((a) => a.starts <= now).length,
    attendance_rate: pct(attended, attended + no_shows),
    no_show_rate: pct(no_shows, attended + no_shows),
  };

  const doctorNames = new Map<number | null, string>(
    db.doctors.filter((d) => d.clinic_id === cid).map((d) => [d.id, d.name]),
  );
  const serviceNames = new Map<number | null, string>(
    db.services.filter((s) => s.clinic_id === cid).map((s) => [s.id, s.name]),
  );

  const countJobs = (status: string) =>
    db.jobs.filter(
      (j) =>
        j.clinic_id === cid &&
        ["outbound", "reminder"].includes(j.kind) &&
        j.status === status &&
        within(j.created, p),
    ).length;

  const attention = db.threads.filter(
    (t) => t.clinic_id === cid && t.channel !== "demo" && Boolean(t.attention),
  ).length;

  let series: Array<{ date: string; enquiries: number; bookings: number }> | null = null;
  if (p.days && p.days <= MAX_SERIES_DAYS && p.first) {
    const counts = new Map<string, [number, number]>();
    for (let i = 0; i < p.days; i++) {
      counts.set(addDaysDateStr(p.first, i), [0, 0]);
    }
    for (const e of cohort) {
      const d = localParts(tz, e.created).dateStr;
      const entry = counts.get(d);
      if (entry) entry[0] += 1;
    }
    for (const a of made) {
      const d = localParts(tz, a.created).dateStr;
      const entry = counts.get(d);
      if (entry) entry[1] += 1;
    }
    series = [...counts.entries()].map(([date, [enq, bkg]]) => ({ date, enquiries: enq, bookings: bkg }));
  }

  const stored = clinic.baseline || {};
  const hasBaseline =
    stored.enquiries_per_week != null || stored.bookings_per_week != null || stored.no_show_percent != null;
  const baseline = hasBaseline
    ? {
        enquiries_per_week: stored.enquiries_per_week ?? null,
        bookings_per_week: stored.bookings_per_week ?? null,
        no_show_percent: stored.no_show_percent ?? null,
        set_on: stored.set_on ?? null,
      }
    : null;

  let comparison: Record<string, { baseline: number; current: number; change: number }> | null = null;
  if (baseline && p.days && p.days >= 7) {
    const current: Record<string, number | null> = {
      enquiries_per_week: Math.round((cohort.length * 70) / p.days) / 10,
      bookings_per_week: Math.round((made.length * 70) / p.days) / 10,
      no_show_percent: attendance.no_show_rate,
    };
    comparison = {};
    for (const key of ["enquiries_per_week", "bookings_per_week", "no_show_percent"] as const) {
      const bVal = baseline[key];
      const cVal = current[key];
      if (bVal != null && cVal != null) {
        comparison[key] = {
          baseline: bVal,
          current: cVal,
          change: Math.round((cVal - bVal) * 10) / 10,
        };
      }
    }
  }

  return {
    period: {
      key: p.key,
      label: p.label,
      start: p.start,
      end: p.end,
      days: p.days,
      first: p.first,
      last: p.last,
    },
    enquiries: {
      total: cohort.length,
      booked: booked.length,
      open: cohort.filter((e) => (OPEN_STATUSES as readonly string[]).includes(e.status)).length,
      lost: cohort.filter((e) => e.status === "lost").length,
      conversion_rate: pct(booked.length, cohort.length),
      by_source,
      overdue_followups: overdueCount,
    },
    bookings: {
      made: made.length,
      whatsapp: made.filter((a) => a.source === "whatsapp").length,
      staff: made.filter((a) => a.source !== "whatsapp").length,
      direct_without_enquiry: direct.length,
    },
    attendance,
    by_doctor: breakdown(visits, doctorNames, "doctor_id"),
    by_service: breakdown(visits, serviceNames, "service_id"),
    messaging: { failed: countJobs("failed"), uncertain: countJobs("uncertain"), needs_attention: attention },
    series,
    baseline,
    comparison,
    definition: DEFINITION,
  };
}

function safeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  return `"${s.replaceAll('"', '""')}"`;
}

export function exportPerformanceCsv(data: ReturnType<typeof performanceReport>, clinicName: string): string {
  const rows: Array<Array<unknown>> = [["section", "item", "metric", "value"]];
  const add = (section: string, item: string, metric: string, value: unknown) =>
    rows.push([section, item, metric, value]);

  add("Period", "", "Clinic", clinicName);
  add("Period", "", "Range", data.period.label);
  add("Period", "", "From", data.period.first);
  add("Period", "", "To", data.period.last);

  const e = data.enquiries;
  add("Enquiries", "", "Total", e.total);
  add("Enquiries", "", "Booked", e.booked);
  add("Enquiries", "", "Open", e.open);
  add("Enquiries", "", "Lost", e.lost);
  add("Enquiries", "", "Conversion rate (%)", e.conversion_rate);
  add("Enquiries", "", "Overdue follow-ups", e.overdue_followups);
  for (const row of e.by_source) {
    add("By source", row.source, "Enquiries", row.enquiries);
    add("By source", row.source, "Booked", row.booked);
    add("By source", row.source, "Conversion rate (%)", row.conversion_rate);
  }

  const b = data.bookings;
  add("Bookings", "", "Made", b.made);
  add("Bookings", "", "WhatsApp", b.whatsapp);
  add("Bookings", "", "Staff", b.staff);
  add("Bookings", "", "Direct without enquiry", b.direct_without_enquiry);

  const a = data.attendance;
  add("Attendance", "", "Attended", a.attended);
  add("Attendance", "", "No-shows", a.no_shows);
  add("Attendance", "", "Cancelled", a.cancelled);
  add("Attendance", "", "Upcoming", a.upcoming);
  add("Attendance", "", "Outcome not recorded", a.unrecorded);
  add("Attendance", "", "Attendance rate (%)", a.attendance_rate);
  add("Attendance", "", "No-show rate (%)", a.no_show_rate);

  for (const [section, table] of [
    ["By doctor", data.by_doctor],
    ["By service", data.by_service],
  ] as const) {
    for (const row of table) {
      add(section, row.name, "Booked", row.booked);
      add(section, row.name, "Attended", row.attended);
      add(section, row.name, "No-shows", row.no_shows);
      add(section, row.name, "Cancelled", row.cancelled);
      add(section, row.name, "Recorded payments", row.recorded_payments);
    }
  }

  add("Messaging", "", "Failed sends", data.messaging.failed);
  add("Messaging", "", "Uncertain sends", data.messaging.uncertain);
  add("Messaging", "", "Conversations needing attention", data.messaging.needs_attention);

  for (const row of data.series || []) {
    add("Daily", row.date, "Enquiries", row.enquiries);
    add("Daily", row.date, "Bookings", row.bookings);
  }
  for (const [metric, row] of Object.entries(data.comparison || {})) {
    add("Baseline comparison", metric, "Baseline", row.baseline);
    add("Baseline comparison", metric, "Current", row.current);
    add("Baseline comparison", metric, "Change", row.change);
  }
  add("Note", "", "Definition", data.definition);

  return "\ufeff" + rows.map((r) => r.map(safeCsvCell).join(",")).join("\r\n") + "\r\n";
}
