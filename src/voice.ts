import { Clinic, HttpError, VoiceCall, db, nowSec } from "./store.js";
import { localParts } from "./booking.js";

export interface VoicePackSpec {
  id: "none" | "starter_100" | "growth_300" | "pro_500";
  label: string;
  minutes: number;
  monthly_fee: number;
  extra_rate: number;
  effective_per_min: number;
}

export const VOICE_PACKS: VoicePackSpec[] = [
  {
    id: "none",
    label: "Not active (0 min)",
    minutes: 0,
    monthly_fee: 0,
    extra_rate: 15,
    effective_per_min: 0,
  },
  {
    id: "starter_100",
    label: "Voice Starter — 100 min",
    minutes: 100,
    monthly_fee: 1499,
    extra_rate: 15,
    effective_per_min: 14.99,
  },
  {
    id: "growth_300",
    label: "Voice Growth — 300 min",
    minutes: 300,
    monthly_fee: 3499,
    extra_rate: 15,
    effective_per_min: 11.66,
  },
  {
    id: "pro_500",
    label: "Voice Pro — 500 min",
    minutes: 500,
    monthly_fee: 5499,
    extra_rate: 15,
    effective_per_min: 11,
  },
];

export function packById(id?: string | null): VoicePackSpec {
  return VOICE_PACKS.find((p) => p.id === id) || VOICE_PACKS[0];
}

export function billableMinutes(durationSeconds: number): number {
  const s = Math.max(0, Math.round(Number(durationSeconds) || 0));
  if (s === 0) return 0;
  return Math.ceil(s / 60);
}

export interface VoiceUsageSummary {
  month: string;
  pack_id: VoicePackSpec["id"];
  pack_label: string;
  pack_monthly_fee: number;
  minutes_included: number;
  minutes_used: number;
  minutes_remaining: number;
  overage_minutes: number;
  usage_percent: number;
  alert_threshold_pct: number;
  extra_rate_inr: number;
  overage_charge_inr: number;
  estimated_provider_cost_inr: number;
  estimated_contribution_inr: number;
  total_calls: number;
  inbound_calls: number;
  outbound_calls: number;
  booking_requests: number;
  missed_calls: number;
  avg_duration_seconds: number;
  alert_level: "inactive" | "ok" | "warning" | "exceeded";
  alert_message: string;
}

export function voiceUsageForMonth(clinic: Clinic, nowInput?: number): VoiceUsageSummary {
  const now = Math.floor(nowInput || nowSec());
  const month = localParts(clinic.timezone, now).dateStr.slice(0, 7);
  const pack = packById(clinic.voice_pack || "none");
  const minutesIncluded =
    typeof clinic.voice_minutes_included === "number" && clinic.voice_minutes_included >= 0
      ? clinic.voice_minutes_included
      : pack.minutes;
  const extraRate =
    typeof clinic.voice_extra_rate === "number" && clinic.voice_extra_rate >= 0
      ? clinic.voice_extra_rate
      : pack.extra_rate;
  const costPerMin =
    typeof clinic.voice_cost_per_min === "number" && clinic.voice_cost_per_min >= 0
      ? clinic.voice_cost_per_min
      : 6;
  const thresholdPct = Math.max(50, Math.min(99, Number(clinic.voice_alert_threshold_pct ?? 80)));

  const calls = db.voice_calls.filter(
    (c) => c.clinic_id === clinic.id && localParts(clinic.timezone, c.created).dateStr.slice(0, 7) === month,
  );
  const minutesUsed = calls.reduce((sum, c) => sum + (c.billable_minutes || 0), 0);
  const totalDur = calls.reduce((sum, c) => sum + (c.duration_seconds || 0), 0);
  const minutesRemaining = Math.max(0, minutesIncluded - minutesUsed);
  const overageMinutes = Math.max(0, minutesUsed - minutesIncluded);
  const overageCharge = overageMinutes * extraRate;
  const usagePercent =
    minutesIncluded > 0
      ? Math.round((minutesUsed / minutesIncluded) * 100)
      : minutesUsed > 0
        ? 100
        : 0;
  const estProviderCost = minutesUsed * costPerMin;
  const estRevenue = pack.monthly_fee + overageCharge;
  const estContribution = estRevenue - estProviderCost;

  let alertLevel: VoiceUsageSummary["alert_level"] = "ok";
  let alertMessage = `${minutesRemaining} of ${minutesIncluded} included minutes remaining this month.`;

  if (minutesIncluded === 0 && minutesUsed === 0) {
    alertLevel = "inactive";
    alertMessage = "Select a prepaid voice minute pack below to start tracking monthly allowance.";
  } else if (minutesUsed >= minutesIncluded && minutesIncluded > 0) {
    alertLevel = "exceeded";
    alertMessage =
      overageMinutes > 0
        ? `Monthly pack (${minutesIncluded} min) exceeded by ${overageMinutes} min (₹${overageCharge} extra at ₹${extraRate}/min). Upgrade pack or top up minutes.`
        : `Monthly pack (${minutesIncluded} min) is 100% used. Additional calls will bill at ₹${extraRate}/min.`;
  } else if (minutesIncluded === 0 && minutesUsed > 0) {
    alertLevel = "exceeded";
    alertMessage = `${minutesUsed} voice minute(s) logged with no prepaid pack active (₹${overageCharge} pay-as-you-go at ₹${extraRate}/min).`;
  } else if (usagePercent >= thresholdPct) {
    alertLevel = "warning";
    alertMessage = `${usagePercent}% of monthly voice pack used (${minutesUsed}/${minutesIncluded} min). Only ${minutesRemaining} min remaining.`;
  }

  return {
    month,
    pack_id: pack.id,
    pack_label: pack.label,
    pack_monthly_fee: pack.monthly_fee,
    minutes_included: minutesIncluded,
    minutes_used: minutesUsed,
    minutes_remaining: minutesRemaining,
    overage_minutes: overageMinutes,
    usage_percent: usagePercent,
    alert_threshold_pct: thresholdPct,
    extra_rate_inr: extraRate,
    overage_charge_inr: overageCharge,
    estimated_provider_cost_inr: estProviderCost,
    estimated_contribution_inr: estContribution,
    total_calls: calls.length,
    inbound_calls: calls.filter((c) => c.direction === "inbound").length,
    outbound_calls: calls.filter((c) => c.direction === "outbound").length,
    booking_requests: calls.filter((c) => c.outcome === "booking_requested").length,
    missed_calls: calls.filter((c) => c.outcome === "missed" || c.outcome === "voicemail").length,
    avg_duration_seconds: calls.length ? Math.round(totalDur / calls.length) : 0,
    alert_level: alertLevel,
    alert_message: alertMessage,
  };
}

export interface NormalizedVoiceCall {
  clinic_id: number;
  call_id: string;
  direction: VoiceCall["direction"];
  provider: VoiceCall["provider"];
  caller_name: string;
  contact: string;
  duration_seconds: number;
  outcome: VoiceCall["outcome"];
  summary: string;
  transcript: string;
  started_at: number;
  ended_at: number;
}

const VALID_OUTCOMES = new Set<VoiceCall["outcome"]>([
  "booking_requested",
  "info_answered",
  "transferred",
  "missed",
  "voicemail",
  "reminder_confirmed",
]);

const VALID_PROVIDERS = new Set<VoiceCall["provider"]>([
  "vapi",
  "bolna",
  "plivo",
  "retell",
  "demo",
]);

function parseEpoch(val: unknown, fallback: number): number {
  if (typeof val === "number" && Number.isFinite(val) && val > 1_000_000_000) {
    return val > 10_000_000_000 ? Math.floor(val / 1000) : Math.floor(val);
  }
  if (typeof val === "string" && val.trim()) {
    const ms = Date.parse(val);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return fallback;
}

export function normalizeVoiceWebhookPayload(raw: Record<string, any>): NormalizedVoiceCall {
  const now = nowSec();
  // Support Vapi end-of-call-report nested payload as well as flat payloads from Bolna/Plivo/Retell
  const vapiMsg = raw?.message && typeof raw.message === "object" ? raw.message : null;
  const vapiCall = vapiMsg?.call && typeof vapiMsg.call === "object" ? vapiMsg.call : null;

  const clinicIdRaw =
    raw.clinic_id ??
    vapiCall?.metadata?.clinic_id ??
    vapiMsg?.assistant?.metadata?.clinic_id ??
    raw?.metadata?.clinic_id;
  const clinic_id = Number(clinicIdRaw);
  if (!Number.isInteger(clinic_id) || clinic_id <= 0) {
    throw new HttpError(422, "Valid clinic_id is required");
  }

  const call_id = String(raw.call_id || vapiCall?.id || raw.id || "").trim().slice(0, 120);
  if (call_id.length < 3) {
    throw new HttpError(422, "Valid call_id is required");
  }

  const rawDir = String(
    raw.direction || (vapiCall?.type?.includes("outbound") ? "outbound" : "inbound"),
  ).toLowerCase();
  const direction: VoiceCall["direction"] = rawDir === "outbound" ? "outbound" : "inbound";

  const rawProv = String(raw.provider || (vapiMsg ? "vapi" : "vapi")).toLowerCase() as VoiceCall["provider"];
  const provider: VoiceCall["provider"] = VALID_PROVIDERS.has(rawProv) ? rawProv : "vapi";

  const caller_name = String(
    raw.caller_name || raw.name || vapiCall?.customer?.name || "Phone caller",
  )
    .trim()
    .slice(0, 120);
  const contact = String(
    raw.contact || raw.phone || raw.from_number || raw.user_number || vapiCall?.customer?.number || "",
  )
    .replace(/\D/g, "")
    .slice(0, 20);

  const started_at = parseEpoch(raw.started_at ?? vapiCall?.startedAt, now);
  const ended_at = parseEpoch(raw.ended_at ?? vapiCall?.endedAt, now);
  let duration_seconds = Math.max(
    0,
    Math.min(
      14400,
      Math.round(
        Number(
          raw.duration_seconds ??
            vapiMsg?.durationSeconds ??
            raw.call_length ??
            Math.max(0, ended_at - started_at),
        ) || 0,
      ),
    ),
  );
  if (duration_seconds === 0 && ended_at > started_at) {
    duration_seconds = Math.min(14400, ended_at - started_at);
  }

  const rawOutcome = String(raw.outcome || "").trim().toLowerCase() as VoiceCall["outcome"];
  let outcome: VoiceCall["outcome"] = VALID_OUTCOMES.has(rawOutcome) ? rawOutcome : "info_answered";
  if (!VALID_OUTCOMES.has(rawOutcome)) {
    const reason = String(vapiMsg?.endedReason || raw.status || "").toLowerCase();
    if (/voicemail/.test(reason)) outcome = "voicemail";
    else if (/no.?answer|busy|failed|missed/.test(reason) || duration_seconds === 0) outcome = "missed";
    else if (/transfer|forward/.test(reason)) outcome = "transferred";
  }

  const summary = String(raw.summary || vapiMsg?.summary || vapiMsg?.analysis?.summary || "")
    .trim()
    .slice(0, 1000);
  const transcript = String(raw.transcript || vapiMsg?.transcript || vapiMsg?.artifact?.transcript || "")
    .trim()
    .slice(0, 12000);

  return {
    clinic_id,
    call_id,
    direction,
    provider,
    caller_name: caller_name || "Phone caller",
    contact,
    duration_seconds,
    outcome,
    summary,
    transcript,
    started_at,
    ended_at,
  };
}

export function recordVoiceCall(
  clinic: Clinic,
  input: NormalizedVoiceCall,
): { call: VoiceCall; created: boolean; usage: VoiceUsageSummary } {
  const existing = db.voice_calls.find(
    (c) => c.clinic_id === clinic.id && c.call_id === input.call_id,
  );

  // Link to an existing WhatsApp/voice thread or enquiry if present
  const voiceMsg = db.messages.find(
    (m) => m.provider_id === `voice:${clinic.id}:${input.call_id}`,
  );
  const matchedThread = voiceMsg
    ? db.threads.find((t) => t.id === voiceMsg.thread_id && t.clinic_id === clinic.id) || null
    : input.contact
      ? db.threads.find((t) => t.clinic_id === clinic.id && t.contact === input.contact) || null
      : null;
  const matchedEnquiry = input.contact
    ? db.enquiries.find((e) => e.clinic_id === clinic.id && e.contact === input.contact) || null
    : null;

  const mins = input.outcome === "missed" && input.duration_seconds === 0 ? 0 : billableMinutes(input.duration_seconds);

  if (existing) {
    existing.duration_seconds = Math.max(existing.duration_seconds, input.duration_seconds);
    existing.billable_minutes = Math.max(existing.billable_minutes, mins);
    if (input.summary) existing.summary = input.summary;
    if (input.transcript) existing.transcript = input.transcript;
    if (input.outcome) existing.outcome = input.outcome;
    if (!existing.thread_id && matchedThread) existing.thread_id = matchedThread.id;
    if (!existing.enquiry_id && matchedEnquiry) existing.enquiry_id = matchedEnquiry.id;
    return { call: existing, created: false, usage: voiceUsageForMonth(clinic) };
  }

  const call: VoiceCall = {
    id: db.nextId("voice_calls"),
    clinic_id: clinic.id,
    call_id: input.call_id,
    direction: input.direction,
    provider: input.provider,
    caller_name: input.caller_name,
    contact: input.contact,
    duration_seconds: input.duration_seconds,
    billable_minutes: mins,
    outcome: input.outcome,
    summary: input.summary,
    transcript: input.transcript,
    thread_id: matchedThread?.id ?? null,
    enquiry_id: matchedEnquiry?.id ?? null,
    started_at: input.started_at,
    ended_at: input.ended_at,
    created: nowSec(),
  };
  db.voice_calls.push(call);
  db.audit("voice_ai", "voice.call_logged", `${call.call_id} (${mins}m)`, clinic.id);
  return { call, created: true, usage: voiceUsageForMonth(clinic) };
}
