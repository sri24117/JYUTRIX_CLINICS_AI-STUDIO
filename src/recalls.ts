import {
  Clinic,
  HttpError,
  RecallCampaign,
  RecallDispatch,
  db,
  nowSec,
} from "./store.js";
import { getThread, queueReply } from "./receptionist.js";

export interface RecallCandidate {
  contact: string;
  patient_name: string;
  appointment_id: number;
  last_visit: number;
  days_since: number;
  reason: string;
  opted_out: boolean;
  has_consent: boolean;
  eligible: boolean;
  channel: "whatsapp" | "demo";
}

export const RECALL_TEMPLATES: Record<
  RecallCampaign["kind"],
  { label: string; template_name: string; default_days: number; buildMessage: (clinic: Clinic, name: string) => string }
> = {
  six_month_checkup: {
    label: "6-Month Dental Cleaning & Checkup Recall",
    template_name: "jyutrix_recall_checkup",
    default_days: 180,
    buildMessage: (clinic, name) =>
      `Hello ${name}, it has been a while since your last visit at ${clinic.name}. Routine checkups and scaling help prevent bigger issues. Reply BOOK to see open slots with ${clinic.doctor}, or STOP to opt out.`,
  },
  missed_slot_recovery: {
    label: "Cancelled / No-Show Slot Recovery",
    template_name: "jyutrix_missed_slot_recovery",
    default_days: 30,
    buildMessage: (clinic, name) =>
      `Hello ${name}, we noticed you could not make your recent appointment at ${clinic.name}. Would you like to reschedule at a convenient time? Reply BOOK to see open slots, or STOP to opt out.`,
  },
  custom_recall: {
    label: "Custom Patient Recall",
    template_name: "jyutrix_custom_recall",
    default_days: 90,
    buildMessage: (clinic, name) =>
      `Hello ${name}, a quick follow-up from ${clinic.name}. Reply BOOK if you would like to schedule your next visit with ${clinic.doctor}, or STOP to opt out.`,
  },
};

export function findRecallCandidates(
  clinic: Clinic,
  kind: RecallCampaign["kind"],
  daysOverride?: number | null,
): RecallCandidate[] {
  const now = nowSec();
  const spec = RECALL_TEMPLATES[kind] || RECALL_TEMPLATES.six_month_checkup;
  const days =
    daysOverride !== undefined && daysOverride !== null && Number.isFinite(Number(daysOverride))
      ? Math.max(0, Math.min(3650, Math.round(Number(daysOverride))))
      : spec.default_days;

  const upcomingContacts = new Set(
    db.appointments
      .filter((a) => a.clinic_id === clinic.id && a.status === "confirmed" && a.starts > now)
      .map((a) => a.contact),
  );

  // Pick the most recent relevant appointment per patient contact
  const byContact = new Map<string, (typeof db.appointments)[number]>();
  const clinicAppts = db.appointments
    .filter((a) => a.clinic_id === clinic.id && Boolean(a.contact))
    .sort((a, b) => b.starts - a.starts);

  for (const a of clinicAppts) {
    if (upcomingContacts.has(a.contact)) continue;
    if (byContact.has(a.contact)) continue;

    if (kind === "missed_slot_recovery") {
      if (!["cancelled", "no_show"].includes(a.status)) continue;
      const ageDays = Math.floor(Math.max(0, now - a.starts) / 86400);
      if (days > 0 && ageDays > days) continue;
      byContact.set(a.contact, a);
    } else {
      if (a.status !== "completed") continue;
      const ageDays = Math.floor(Math.max(0, now - a.starts) / 86400);
      if (ageDays < days) continue;
      byContact.set(a.contact, a);
    }
  }

  const out: RecallCandidate[] = [];
  for (const a of byContact.values()) {
    const thread =
      (a.thread_id ? db.threads.find((t) => t.id === a.thread_id && t.clinic_id === clinic.id) : null) ||
      db.threads.find((t) => t.clinic_id === clinic.id && t.contact === a.contact) ||
      null;
    const optedOut = Boolean(thread?.opted_out);
    const channel: "whatsapp" | "demo" = a.source === "demo" || thread?.channel === "demo" ? "demo" : "whatsapp";
    const hasConsent = channel === "demo" ? !optedOut : Boolean(a.consent || thread?.consent);
    const daysSince = Math.floor(Math.max(0, now - a.starts) / 86400);
    out.push({
      contact: a.contact,
      patient_name: a.name,
      appointment_id: a.id,
      last_visit: a.starts,
      days_since: daysSince,
      reason:
        kind === "missed_slot_recovery"
          ? a.status === "no_show"
            ? "Missed visit (no-show)"
            : "Cancelled appointment"
          : `Completed visit (${daysSince}d ago)`,
      opted_out: optedOut,
      has_consent: hasConsent,
      eligible: !optedOut && hasConsent,
      channel,
    });
  }

  return out.sort((a, b) => b.days_since - a.days_since);
}

export function launchRecallCampaign(
  clinic: Clinic,
  input: {
    kind: RecallCampaign["kind"];
    name?: string;
    template_name?: string;
    custom_message?: string;
    days?: number | null;
    contacts?: string[];
    actor: string;
  },
): { campaign: RecallCampaign; dispatches: RecallDispatch[] } {
  const kind: RecallCampaign["kind"] =
    input.kind in RECALL_TEMPLATES ? input.kind : "six_month_checkup";
  const spec = RECALL_TEMPLATES[kind];
  const candidates = findRecallCandidates(clinic, kind, input.days);
  const filterSet =
    Array.isArray(input.contacts) && input.contacts.length
      ? new Set(input.contacts.map((c) => String(c).replace(/\D/g, "")))
      : null;

  const selected = filterSet
    ? candidates.filter((c) => filterSet.has(c.contact.replace(/\D/g, "")))
    : candidates;

  if (!selected.length) {
    throw new HttpError(422, "No matching past patients found for this recall filter");
  }

  const templateName = String(input.template_name || spec.template_name).trim().slice(0, 120) || spec.template_name;
  const customMsg = String(input.custom_message || "").trim().slice(0, 800);
  const preview = customMsg || spec.buildMessage(clinic, "{Patient}");

  const now = nowSec();
  const campaign: RecallCampaign = {
    id: db.nextId("recall_campaigns"),
    clinic_id: clinic.id,
    kind,
    name: String(input.name || spec.label).trim().slice(0, 140) || spec.label,
    template_name: templateName,
    message_preview: preview,
    target_count: selected.length,
    sent_count: 0,
    skipped_opted_out: 0,
    created_by: input.actor,
    created: now,
  };
  db.recall_campaigns.push(campaign);

  const dispatches: RecallDispatch[] = [];
  const seen = new Set<string>();

  for (const cand of selected) {
    if (seen.has(cand.contact)) continue;
    seen.add(cand.contact);

    let status: RecallDispatch["status"];
    if (cand.opted_out) {
      status = "skipped_optout";
      campaign.skipped_opted_out += 1;
    } else if (!cand.has_consent) {
      status = "skipped_no_consent";
      campaign.skipped_opted_out += 1;
    } else {
      const thread = getThread(clinic, cand.contact, cand.patient_name, cand.channel);
      const body = customMsg
        ? customMsg.replaceAll("{Patient}", cand.patient_name)
        : spec.buildMessage(clinic, cand.patient_name);
      const text = `[Template: ${templateName}] ${body}`;
      queueReply(clinic, thread, text, `recall:${campaign.id}:${cand.contact}`, "bot");
      thread.updated = now;
      status = cand.channel === "demo" ? "demo_sent" : "queued";
      campaign.sent_count += 1;
    }

    const rec: RecallDispatch = {
      id: db.nextId("recall_dispatches"),
      clinic_id: clinic.id,
      campaign_id: campaign.id,
      contact: cand.contact,
      patient_name: cand.patient_name,
      appointment_id: cand.appointment_id,
      status,
      created: now,
    };
    db.recall_dispatches.push(rec);
    dispatches.push(rec);
  }

  db.audit(
    input.actor,
    "recall.campaign_launched",
    `#${campaign.id} (${campaign.sent_count} sent, ${campaign.skipped_opted_out} skipped)`,
    clinic.id,
  );
  return { campaign, dispatches };
}
