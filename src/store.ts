import crypto from "node:crypto";

export interface ScheduleBreak {
  start: string;
  end: string;
}

export interface Schedule {
  open: string;
  close: string;
  duration: number;
  closed_days: number[];
  breaks: ScheduleBreak[];
  leave_dates: string[];
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface BaselineData {
  enquiries_per_week?: number | null;
  bookings_per_week?: number | null;
  no_show_percent?: number | null;
  set_on?: number;
}

export interface SignoffRecord {
  by: string;
  at: number;
}

export interface Clinic {
  id: number;
  name: string;
  doctor: string;
  phone: string;
  address: string;
  timezone: string;
  fee: number;
  schedule: Schedule;
  services: string[];
  faqs: FaqItem[];
  number_id: string | null;
  enabled: boolean;
  template_approved: boolean;
  reminder_buttons_approved: boolean;
  plan: string;
  monthly_fee: number;
  monthly_limit: number;
  pilot_end: number | null;
  followup_hours: number;
  baseline: BaselineData | null;
  onboarding: { signoffs?: Record<string, SignoffRecord> };
}

export interface User {
  id: number;
  username: string;
  email?: string | null;
  clerk_user_id?: string | null;
  password_hash: string;
  role: "admin" | "owner" | "receptionist";
  clinic_id: number | null;
  active: boolean;
}

export interface LoginSession {
  token_hash: string;
  csrf: string;
  user_id: number;
  expires: number;
}

export interface Doctor {
  id: number;
  clinic_id: number;
  name: string;
  schedule: Schedule;
  active: boolean;
}

export interface Service {
  id: number;
  clinic_id: number;
  name: string;
  duration: number;
  fee: number;
  active: boolean;
}

export interface Thread {
  id: number;
  clinic_id: number;
  contact: string;
  name: string;
  channel: "whatsapp" | "demo";
  mode: "bot" | "human";
  attention: string;
  state: Record<string, any>;
  consent: boolean;
  opted_out: boolean;
  generation: number;
  last_inbound: number;
  updated: number;
}

export interface Message {
  id: number;
  thread_id: number;
  direction: "in" | "out";
  text: string;
  provider_id: string | null;
  status: string;
  created: number;
}

export interface Job {
  id: number;
  clinic_id: number;
  thread_id: number | null;
  appointment_id: number | null;
  key: string;
  kind: "inbound" | "outbound" | "reminder";
  status: string;
  attempts: number;
  due: number;
  error: string;
  message_id: number | null;
  payload: Record<string, any>;
  created: number;
}

export interface Appointment {
  id: number;
  clinic_id: number;
  doctor_id: number | null;
  service_id: number | null;
  service_fee: number;
  thread_id: number | null;
  name: string;
  contact: string;
  starts: number;
  ends: number;
  status: "confirmed" | "completed" | "no_show" | "cancelled";
  source: "whatsapp" | "staff" | "demo";
  request_key: string;
  consent: boolean;
  paid_amount: number;
  reminder_response: string;
  reminder_response_at: number | null;
  created: number;
}

export interface WaitlistEntry {
  id: number;
  clinic_id: number;
  thread_id: number;
  name: string;
  contact: string;
  consent: boolean;
  status: "waiting" | "offered" | "booked" | "declined" | "expired" | "cancelled";
  doctor_id: number | null;
  service_id: number | null;
  offered_starts: number | null;
  offered_doctor_id: number | null;
  offered_service_id: number | null;
  expires: number | null;
  created: number;
}

export interface EnquiryEvent {
  t: number;
  type: string;
  actor: string;
  text: string;
  outcome?: string;
}

export interface Enquiry {
  id: number;
  clinic_id: number;
  thread_id: number | null;
  appointment_id: number | null;
  name: string;
  contact: string;
  source: "whatsapp" | "website" | "phone" | "walk_in";
  status: "new" | "contacted" | "interested" | "booked" | "lost";
  service_interest: string;
  assigned_to: string | null;
  next_followup: number | null;
  events: EnquiryEvent[];
  last_activity: number;
  created: number;
}

export interface SalesLead {
  id: number;
  name: string;
  clinic_name: string;
  city: string;
  phone: string;
  email: string | null;
  note: string;
  status: "new" | "contacted" | "qualified" | "won" | "closed";
  consent: boolean;
  created: number;
}

export interface AuditLog {
  id: number;
  actor: string;
  action: string;
  target: string;
  clinic_id: number | null;
  created: number;
}

export interface PlanLimits {
  max_doctors: number;
  max_services: number;
  reminder_offsets_hours: number[];
  waitlist: boolean;
  payments: boolean;
  analytics: string;
}

export class HttpError extends Error {
  status: number;
  detail: string;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

export const APP_MODE = (process.env.APP_MODE || "demo").toLowerCase();
export const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "");
export const KAPSO_API_KEY = process.env.KAPSO_API_KEY || "";
export const KAPSO_WEBHOOK_SECRET = process.env.KAPSO_WEBHOOK_SECRET || "";
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
export const VOICE_TOOL_KEY = process.env.VOICE_TOOL_KEY || "";

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  Starter: {
    max_doctors: 1,
    max_services: 10,
    reminder_offsets_hours: [24, 2],
    waitlist: false,
    payments: false,
    analytics: "basic",
  },
  Growth: {
    max_doctors: 5,
    max_services: 30,
    reminder_offsets_hours: [24, 3],
    waitlist: true,
    payments: false,
    analytics: "basic",
  },
  Pro: {
    max_doctors: 25,
    max_services: 100,
    reminder_offsets_hours: [24, 3],
    waitlist: true,
    payments: false,
    analytics: "basic",
  },
};

export function planName(value?: string | null): string {
  const normalized = (value || "Starter").trim().toLowerCase();
  if (["pilot", "starter", "basic"].includes(normalized)) return "Starter";
  if (normalized === "growth") return "Growth";
  if (normalized === "pro") return "Pro";
  return "Starter";
}

export function limitsFor(clinic: Clinic): PlanLimits {
  return PLAN_LIMITS[planName(clinic.plan)];
}

export function defaultSchedule(): Schedule {
  return {
    open: "09:00",
    close: "19:00",
    duration: 30,
    closed_days: [6],
    breaks: [{ start: "13:00", end: "14:00" }],
    leave_dates: [],
  };
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return `${salt}$${digest}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [salt, digest] = stored.split("$");
    if (!salt || !digest) return false;
    const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(derived, "utf8"), Buffer.from(digest, "utf8"));
  } catch {
    return false;
  }
}

export function digestToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// In-memory store (replaces SQLAlchemy/PostgreSQL for AI Studio Node.js runtime)
class MemoryStore {
  private seq = new Map<string, number>();

  clinics: Clinic[] = [];
  users: User[] = [];
  sessions = new Map<string, LoginSession>();
  doctors: Doctor[] = [];
  services: Service[] = [];
  threads: Thread[] = [];
  messages: Message[] = [];
  jobs: Job[] = [];
  appointments: Appointment[] = [];
  waitlist: WaitlistEntry[] = [];
  enquiries: Enquiry[] = [];
  leads: SalesLead[] = [];
  audits: AuditLog[] = [];
  deliveries = new Set<string>();
  rateBuckets = new Map<string, { count: number; resetAt: number }>();
  workerHeartbeat: number = nowSec();

  nextId(table: string): number {
    const next = (this.seq.get(table) || 0) + 1;
    this.seq.set(table, next);
    return next;
  }

  exportSequences(): Record<string, number> {
    return Object.fromEntries(this.seq.entries());
  }

  restoreSequences(map: Record<string, number>): void {
    this.seq.clear();
    for (const [k, v] of Object.entries(map)) {
      if (typeof v === "number" && Number.isFinite(v)) this.seq.set(k, v);
    }
  }

  recomputeSequences(): void {
    const maxId = (arr: Array<{ id: number }>) => arr.reduce((m, x) => (x.id > m ? x.id : m), 0);
    this.seq.set("clinics", maxId(this.clinics));
    this.seq.set("users", maxId(this.users));
    this.seq.set("doctors", maxId(this.doctors));
    this.seq.set("services", maxId(this.services));
    this.seq.set("threads", maxId(this.threads));
    this.seq.set("messages", maxId(this.messages));
    this.seq.set("jobs", maxId(this.jobs));
    this.seq.set("appointments", maxId(this.appointments));
    this.seq.set("waitlist", maxId(this.waitlist));
    this.seq.set("enquiries", maxId(this.enquiries));
    this.seq.set("leads", maxId(this.leads));
    this.seq.set("audits", maxId(this.audits));
  }

  audit(actor: string, action: string, target: string | number, clinicId: number | null = null): void {
    this.audits.push({
      id: this.nextId("audits"),
      actor,
      action,
      target: String(target),
      clinic_id: clinicId,
      created: nowSec(),
    });
  }

  checkRateLimit(key: string, maximum = 10, windowSec = 300): void {
    const now = nowSec();
    let bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowSec };
      this.rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maximum) {
      throw new HttpError(429, "Too many attempts. Try again later.");
    }
  }

  bootstrap(): void {
    if (!this.users.some((u) => u.username === "admin")) {
      const password = process.env.ADMIN_PASSWORD || (APP_MODE === "demo" ? "demo-reception-2026" : "");
      if (!password) {
        throw new Error("ADMIN_PASSWORD is required in production mode");
      }
      this.users.push({
        id: this.nextId("users"),
        username: "admin",
        password_hash: hashPassword(password),
        role: "admin",
        clinic_id: null,
        active: true,
      });
    }

    if (APP_MODE === "demo" && this.clinics.length === 0) {
      const clinic: Clinic = {
        id: this.nextId("clinics"),
        name: "Demo Dental Clinic",
        doctor: "Dr. Demo",
        phone: "+919999000000",
        address: "Demo address, Hyderabad",
        timezone: "Asia/Kolkata",
        fee: 500,
        schedule: defaultSchedule(),
        services: ["Dental consultation", "Cleaning", "Root canal consultation"],
        faqs: [
          {
            question: "Do you accept card payments?",
            answer: "Yes, card and UPI payments are accepted at reception.",
          },
        ],
        number_id: null,
        enabled: true,
        template_approved: false,
        reminder_buttons_approved: false,
        plan: "Pilot",
        monthly_fee: 4999,
        monthly_limit: 2000,
        pilot_end: null,
        followup_hours: 4,
        baseline: null,
        onboarding: {},
      };
      this.clinics.push(clinic);
      ensureCatalog(clinic);
    }
  }
}

export const db = new MemoryStore();

export function ensureCatalog(clinic: Clinic): { doctors: Doctor[]; services: Service[] } {
  let doctors = db.doctors.filter((d) => d.clinic_id === clinic.id).sort((a, b) => a.id - b.id);
  if (doctors.length === 0) {
    const d: Doctor = {
      id: db.nextId("doctors"),
      clinic_id: clinic.id,
      name: clinic.doctor,
      schedule: structuredClone(clinic.schedule),
      active: true,
    };
    db.doctors.push(d);
    doctors = [d];
  }
  let services = db.services.filter((s) => s.clinic_id === clinic.id).sort((a, b) => a.id - b.id);
  if (services.length === 0) {
    const s: Service = {
      id: db.nextId("services"),
      clinic_id: clinic.id,
      name: (clinic.services?.[0] || "General consultation").slice(0, 120),
      duration: clinic.schedule?.duration || 30,
      fee: clinic.fee,
      active: true,
    };
    db.services.push(s);
    services = [s];
  }
  return { doctors, services };
}

// Keep in-process worker heartbeat fresh
setInterval(() => {
  db.workerHeartbeat = nowSec();
}, 15_000).unref();
