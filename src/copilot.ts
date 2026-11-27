import { Clinic, db, nowSec } from "./store.js";
import { localParts } from "./booking.js";
import { followupQueue } from "./enquiries.js";
import { performanceReport, resolvePeriod } from "./reports.js";
import { voiceUsageForMonth } from "./voice.js";

export interface CopilotResult {
  tool: string;
  intent: string;
  period: string;
  answer: string;
  metrics: Record<string, unknown>;
}

/**
 * Read-only Owner Reporting Copilot backed strictly by verified, clinic-scoped
 * transactional queries (never arbitrary SQL, never guesses).
 */
export function answerCopilotQuestion(clinic: Clinic, rawQuestion: string): CopilotResult {
  const q = rawQuestion.trim().toLowerCase();
  const periodKey = /today/.test(q)
    ? "today"
    : /week|7\s*day/.test(q)
      ? "7d"
      : /all\s*time|ever/.test(q)
        ? "all"
        : /this\s*month/.test(q)
          ? "month"
          : "30d";

  // 1. Overdue / pending follow-ups
  if (/follow.?up|overdue|pending\s*call|callback/.test(q)) {
    const queue = followupQueue(clinic);
    const dueList = [...queue.overdue, ...queue.today];
    const totalDue = queue.counts.overdue + queue.counts.today;
    const topNames = dueList.slice(0, 5).map((i) => `${i.name} (${i.contact})`).join(", ");
    return {
      tool: "pending_followups",
      intent: "pending_followups",
      period: "Current queue",
      answer: totalDue
        ? `You have ${totalDue} open follow-up(s) due (${queue.counts.overdue} overdue, ${queue.counts.today} due today). Next up: ${topNames}.`
        : "You have 0 pending follow-ups right now — all open enquiries are up to date.",
      metrics: {
        total: totalDue,
        overdue: queue.counts.overdue,
        due_today: queue.counts.today,
        unscheduled: queue.counts.unscheduled,
      },
    };
  }

  // 2. Patient reviews & ratings
  if (/review|rating|feedback|star|google|reputation|complaint/.test(q)) {
    const list = db.reviews.filter((r) => r.clinic_id === clinic.id);
    const rated = list.filter((r) => typeof r.rating === "number");
    const avg = rated.length
      ? Math.round((rated.reduce((sum, r) => sum + (r.rating || 0), 0) / rated.length) * 10) / 10
      : null;
    const happy = list.filter((r) => r.status === "happy_link_sent").length;
    const escalated = list.filter((r) => r.status === "escalated").length;
    return {
      tool: "review_summary",
      intent: "review_summary",
      period: "All retained visits",
      answer: list.length
        ? `${list.length} post-visit feedback request(s) sent. Average rating: ${avg !== null ? `${avg}/5` : "no replies yet"} across ${rated.length} response(s). ${happy} happy patient(s) received your Google Review link and ${escalated} low-rating complaint(s) were caught privately.`
        : "No post-visit review requests have been sent yet. Mark an appointment Completed to trigger automatic feedback collection.",
      metrics: {
        total: list.length,
        responses: rated.length,
        average_rating: avg,
        happy_links_sent: happy,
        private_escalations: escalated,
      },
    };
  }

  // 2b. Voice AI minute usage & call logs
  if (/voice|minute|call\s*log|vapi|bolna|telephony|overage/.test(q)) {
    const v = voiceUsageForMonth(clinic);
    return {
      tool: "voice_usage",
      intent: "voice_usage",
      period: `Month ${v.month}`,
      answer: `Voice AI (${v.pack_label}): ${v.minutes_used} of ${v.minutes_included} included minutes used (${v.usage_percent}%) across ${v.total_calls} call(s) (${v.inbound_calls} inbound, ${v.outbound_calls} outbound, ${v.booking_requests} booking request(s)). ${v.overage_minutes > 0 ? `Overage: ${v.overage_minutes} min (₹${v.overage_charge_inr}).` : `${v.minutes_remaining} minute(s) remaining.`}`,
      metrics: { ...v },
    };
  }

  // 3. Today's appointments / schedule
  if (/today/.test(q) && /appoint|book|visit|schedule|slot/.test(q)) {
    const todayStr = localParts(clinic.timezone, nowSec()).dateStr;
    const todayAppts = db.appointments.filter(
      (a) =>
        a.clinic_id === clinic.id &&
        a.source !== "demo" &&
        localParts(clinic.timezone, a.starts).dateStr === todayStr,
    );
    const confirmed = todayAppts.filter((a) => a.status === "confirmed").length;
    const completed = todayAppts.filter((a) => a.status === "completed").length;
    const cancelled = todayAppts.filter((a) => a.status === "cancelled").length;
    const noShows = todayAppts.filter((a) => a.status === "no_show").length;
    return {
      tool: "appointments_today",
      intent: "appointments_today",
      period: `Today (${todayStr})`,
      answer: `Today (${todayStr}): ${todayAppts.length} live appointment(s) — ${confirmed} upcoming confirmed, ${completed} completed, ${cancelled} cancelled, ${noShows} no-show(s).`,
      metrics: { date: todayStr, total: todayAppts.length, confirmed, completed, cancelled, no_shows: noShows },
    };
  }

  const window = resolvePeriod(clinic, periodKey, null, null);
  const report = performanceReport(clinic, window);

  // 4. Doctor leaderboard / busiest dentist
  if (/doctor|dentist|most\s*book|busiest/.test(q)) {
    const sorted = [...report.by_doctor].sort((a, b) => b.booked - a.booked);
    if (!sorted.length || sorted[0].booked === 0) {
      return {
        tool: "dentist_schedule_summary",
        intent: "dentist_schedule_summary",
        period: report.period.label,
        answer: `No live appointments were recorded for any doctor in ${report.period.label}.`,
        metrics: { period: report.period.label, doctors: sorted },
      };
    }
    const top = sorted[0];
    const summary = sorted
      .slice(0, 4)
      .map((d) => `${d.name}: ${d.booked} booked (${d.attended} attended, ${d.cancelled} cancelled)`)
      .join(" · ");
    return {
      tool: "dentist_schedule_summary",
      intent: "dentist_schedule_summary",
      period: report.period.label,
      answer: `Top doctor in ${report.period.label}: ${top.name} with ${top.booked} booking(s). Breakdown — ${summary}.`,
      metrics: { period: report.period.label, top_doctor: top, doctors: sorted },
    };
  }

  // 5. Cancellations & no-shows
  if (/cancel|no.?show|miss|attend/.test(q)) {
    const a = report.attendance;
    const totalCancelled = report.by_doctor.reduce((s, d) => s + d.cancelled, 0);
    return {
      tool: "appointment_cancellation_rate",
      intent: "appointment_cancellation_rate",
      period: report.period.label,
      answer: `In ${report.period.label}: ${a.attended} attended, ${a.no_shows} no-show(s) (${a.no_show_rate ?? "—"}% no-show rate), and ${totalCancelled} cancelled appointment(s).`,
      metrics: {
        period: report.period.label,
        attended: a.attended,
        no_shows: a.no_shows,
        no_show_rate: a.no_show_rate,
        cancelled: totalCancelled,
      },
    };
  }

  // 6. Enquiries & conversion
  if (/enquir|lead|conver|channel|source|whatsapp/.test(q)) {
    const e = report.enquiries;
    const sources = e.by_source
      .filter((s) => s.enquiries > 0)
      .map((s) => `${s.source}: ${s.enquiries} (${s.booked} booked)`)
      .join(", ");
    return {
      tool: "conversion_summary",
      intent: "conversion_summary",
      period: report.period.label,
      answer: `In ${report.period.label}: ${e.total} enquiry(ies) received, ${e.booked} converted to a booking (${e.conversion_rate ?? "—"}% conversion), ${e.open} still open.${sources ? ` By channel — ${sources}.` : ""}`,
      metrics: {
        period: report.period.label,
        total: e.total,
        booked: e.booked,
        conversion_rate: e.conversion_rate,
        by_source: e.by_source,
      },
    };
  }

  // Default: comprehensive executive summary for the requested period
  const e = report.enquiries;
  const b = report.bookings;
  const a = report.attendance;
  return {
    tool: "executive_summary",
    intent: "executive_summary",
    period: report.period.label,
    answer: `${clinic.name} (${report.period.label}): ${e.total} enquiry(ies) (${e.conversion_rate ?? "—"}% → booking), ${b.made} booking(s) created (${b.whatsapp} WhatsApp, ${b.staff} staff), ${a.attended} attended, ${a.no_shows} no-show(s), and ${e.overdue_followups} overdue follow-up(s).`,
    metrics: {
      period: report.period.label,
      enquiries: e.total,
      conversion_rate: e.conversion_rate,
      bookings_made: b.made,
      attended: a.attended,
      no_shows: a.no_shows,
      overdue_followups: e.overdue_followups,
    },
  };
}
