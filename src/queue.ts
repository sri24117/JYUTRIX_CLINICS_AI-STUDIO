import {
  Clinic,
  HttpError,
  QueueToken,
  TokenSessionConfig,
  db,
  defaultTokenSessions,
  nowSec,
} from "./store.js";
import { localParts, parseDateStr } from "./booking.js";

export function getTokenSessions(clinic: Clinic): TokenSessionConfig[] {
  if (Array.isArray(clinic.token_sessions) && clinic.token_sessions.length > 0) {
    return clinic.token_sessions;
  }
  return defaultTokenSessions();
}

export interface SessionQueueSummary {
  id: string;
  label: string;
  start: string;
  end: string;
  max_tokens: number;
  avg_minutes: number;
  now_serving: number | null;
  now_serving_patient: string | null;
  last_issued: number;
  next_token: number;
  waiting_count: number;
  completed_count: number;
  remaining_capacity: number;
  estimated_wait_minutes: number;
  tokens: QueueToken[];
}

export function getQueueBoard(clinic: Clinic, dateInput?: string | null) {
  const date = dateInput ? parseDateStr(dateInput).iso : localParts(clinic.timezone, nowSec()).dateStr;
  const sessions = getTokenSessions(clinic);

  const sessionSummaries: SessionQueueSummary[] = sessions.map((s) => {
    const tokens = db.queue_tokens
      .filter((t) => t.clinic_id === clinic.id && t.date === date && t.session_id === s.id)
      .sort((a, b) => a.token_number - b.token_number);

    const serving = tokens.find((t) => t.status === "serving") || null;
    const waiting = tokens.filter((t) => t.status === "waiting");
    const completed = tokens.filter((t) => t.status === "completed");
    const activeCount = tokens.filter((t) => t.status !== "cancelled").length;
    const lastIssued = tokens.reduce((m, t) => Math.max(m, t.token_number), 0);
    const aheadCount = waiting.length + (serving ? 1 : 0);

    return {
      id: s.id,
      label: s.label,
      start: s.start,
      end: s.end,
      max_tokens: s.max_tokens,
      avg_minutes: s.avg_minutes,
      now_serving: serving?.token_number ?? null,
      now_serving_patient: serving?.patient_name ?? null,
      last_issued: lastIssued,
      next_token: lastIssued + 1,
      waiting_count: waiting.length,
      completed_count: completed.length,
      remaining_capacity: Math.max(0, s.max_tokens - activeCount),
      estimated_wait_minutes: aheadCount * s.avg_minutes,
      tokens,
    };
  });

  return {
    clinic_id: clinic.id,
    date,
    booking_mode: clinic.booking_mode || "slots",
    sessions: sessionSummaries,
  };
}

export function issueQueueToken(
  clinic: Clinic,
  input: {
    date?: string | null;
    session_id: string;
    patient_name: string;
    contact?: string;
    source: QueueToken["source"];
    thread_id?: number | null;
    notes?: string;
    actor?: string;
  },
): { token: QueueToken; session: TokenSessionConfig; estimated_wait_minutes: number } {
  const date = input.date ? parseDateStr(input.date).iso : localParts(clinic.timezone, nowSec()).dateStr;
  const sessions = getTokenSessions(clinic);
  const session = sessions.find((s) => s.id === input.session_id);
  if (!session) {
    throw new HttpError(422, "Unknown queue session");
  }

  const existing = db.queue_tokens.filter(
    (t) => t.clinic_id === clinic.id && t.date === date && t.session_id === session.id,
  );
  const activeCount = existing.filter((t) => t.status !== "cancelled").length;
  if (activeCount >= session.max_tokens) {
    throw new HttpError(409, `${session.label} has reached its maximum of ${session.max_tokens} tokens`);
  }

  const patientName = String(input.patient_name || "").trim().slice(0, 120);
  if (patientName.length < 2) {
    throw new HttpError(422, "Patient name is required");
  }
  const contact = String(input.contact || "").replace(/\D/g, "").slice(0, 20);
  const nextNumber = existing.reduce((m, t) => Math.max(m, t.token_number), 0) + 1;
  const aheadCount = existing.filter((t) => t.status === "waiting" || t.status === "serving").length;
  const estimatedWait = aheadCount * session.avg_minutes;

  const token: QueueToken = {
    id: db.nextId("queue_tokens"),
    clinic_id: clinic.id,
    date,
    session_id: session.id,
    token_number: nextNumber,
    patient_name: patientName,
    contact,
    source: input.source,
    status: "waiting",
    thread_id: input.thread_id ?? null,
    notes: String(input.notes || "").trim().slice(0, 300),
    created: nowSec(),
    called_at: null,
    completed_at: null,
  };
  db.queue_tokens.push(token);
  db.audit(
    input.actor || input.source,
    "queue.token_issued",
    `${date} ${session.id} #${token.token_number}`,
    clinic.id,
  );
  return { token, session, estimated_wait_minutes: estimatedWait };
}

export function advanceQueueSession(
  clinic: Clinic,
  dateInput: string | null | undefined,
  sessionId: string,
  actor: string,
): { completed: QueueToken | null; serving: QueueToken | null } {
  const date = dateInput ? parseDateStr(dateInput).iso : localParts(clinic.timezone, nowSec()).dateStr;
  const now = nowSec();
  const tokens = db.queue_tokens
    .filter((t) => t.clinic_id === clinic.id && t.date === date && t.session_id === sessionId)
    .sort((a, b) => a.token_number - b.token_number);

  const current = tokens.find((t) => t.status === "serving") || null;
  if (current) {
    current.status = "completed";
    current.completed_at = now;
  }

  const next = tokens.find((t) => t.status === "waiting") || null;
  if (next) {
    next.status = "serving";
    next.called_at = now;
    db.audit(actor, "queue.token_called", `${date} ${sessionId} #${next.token_number}`, clinic.id);
  }
  return { completed: current, serving: next };
}
