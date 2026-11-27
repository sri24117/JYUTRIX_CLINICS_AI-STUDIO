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
  walkin_windows?: ScheduleBreak[];
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
  staff_phones?: string[];
  vertical?: string;
  google_review_url?: string | null;
  review_requests_enabled?: boolean;
  voice_pack?: "none" | "starter_100" | "growth_300" | "pro_500";
  voice_minutes_included?: number;
  voice_extra_rate?: number;
  voice_cost_per_min?: number;
  voice_alert_threshold_pct?: number;
  booking_mode?: "slots" | "tokens" | "hybrid";
  token_sessions?: TokenSessionConfig[];
  widget_enabled?: boolean;
  widget_greeting?: string;
}

export interface TokenSessionConfig {
  id: string;
  label: string;
  start: string;
  end: string;
  max_tokens: number;
  avg_minutes: number;
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

export interface SlotHold {
  id: number;
  clinic_id: number;
  doctor_id: number;
  thread_id: number;
  starts: number;
  ends: number;
  demo: boolean;
  expires: number;
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

export interface ReviewRecord {
  id: number;
  clinic_id: number;
  appointment_id: number;
  thread_id: number | null;
  patient_name: string;
  contact: string;
  rating: number | null;
  status: "requested" | "happy_link_sent" | "escalated";
  feedback_note: string;
  created: number;
  responded_at: number | null;
}

export interface VoiceCall {
  id: number;
  clinic_id: number;
  call_id: string;
  direction: "inbound" | "outbound";
  provider: "vapi" | "bolna" | "plivo" | "retell" | "demo";
  caller_name: string;
  contact: string;
  duration_seconds: number;
  billable_minutes: number;
  outcome:
    | "booking_requested"
    | "info_answered"
    | "transferred"
    | "missed"
    | "voicemail"
    | "reminder_confirmed";
  summary: string;
  transcript: string;
  thread_id: number | null;
  enquiry_id: number | null;
  started_at: number;
  ended_at: number;
  created: number;
}

export interface RecallCampaign {
  id: number;
  clinic_id: number;
  kind: "six_month_checkup" | "missed_slot_recovery" | "custom_recall";
  name: string;
  template_name: string;
  message_preview: string;
  target_count: number;
  sent_count: number;
  skipped_opted_out: number;
  created_by: string;
  created: number;
}

export interface RecallDispatch {
  id: number;
  clinic_id: number;
  campaign_id: number;
  contact: string;
  patient_name: string;
  appointment_id: number | null;
  status: "queued" | "demo_sent" | "skipped_optout" | "skipped_no_consent";
  created: number;
}

export interface QueueToken {
  id: number;
  clinic_id: number;
  date: string;
  session_id: string;
  token_number: number;
  patient_name: string;
  contact: string;
  source: "walk_in" | "whatsapp" | "phone" | "demo";
  status: "waiting" | "serving" | "completed" | "skipped" | "cancelled";
  thread_id: number | null;
  notes: string;
  created: number;
  called_at: number | null;
  completed_at: number | null;
}

export function defaultTokenSessions(): TokenSessionConfig[] {
  return [
    { id: "morning", label: "Morning Session", start: "09:30", end: "13:00", max_tokens: 30, avg_minutes: 10 },
    { id: "evening", label: "Evening Session", start: "16:30", end: "20:00", max_tokens: 25, avg_minutes: 10 },
  ];
}

export interface VerticalPreset {
  id: string;
  label: string;
  description: string;
  default_fee: number;
  services: Array<{ name: string; duration: number; fee: number }>;
  faqs: FaqItem[];
}

export const VERTICAL_PRESETS: VerticalPreset[] = [
  {
    id: "dental",
    label: "Dental Clinic",
    description: "Independent dental clinics (consultations, scaling, fillings, RCT, aligners)",
    default_fee: 500,
    services: [
      { name: "Dental consultation & check-up", duration: 20, fee: 400 },
      { name: "Dental scaling & polishing (cleaning)", duration: 30, fee: 1500 },
      { name: "Tooth filling (composite)", duration: 45, fee: 1500 },
      { name: "Root canal consultation", duration: 30, fee: 500 },
      { name: "Tooth extraction consultation", duration: 30, fee: 500 },
      { name: "Orthodontic / braces & aligners consult", duration: 30, fee: 500 },
      { name: "Teeth whitening consultation", duration: 30, fee: 500 },
    ],
    faqs: [
      { question: "Do you accept UPI or card payments?", answer: "Yes, UPI, cards, and cash are accepted at reception." },
      { question: "How much does a root canal or implant cost?", answer: "Consultation is Rs 500. Exact treatment pricing is shared by the dentist after examination and X-ray." },
    ],
  },
  {
    id: "dermatology",
    label: "Dermatology & Skin Clinic",
    description: "Skin, hair fall, acne, laser & aesthetic dermatology clinics",
    default_fee: 700,
    services: [
      { name: "Skin consultation", duration: 20, fee: 700 },
      { name: "Hair fall & scalp consultation", duration: 20, fee: 700 },
      { name: "Acne & scar consultation", duration: 20, fee: 700 },
      { name: "Chemical peel session", duration: 30, fee: 2500 },
      { name: "Laser hair reduction consultation", duration: 30, fee: 500 },
      { name: "PRP hair therapy consultation", duration: 30, fee: 700 },
    ],
    faqs: [
      { question: "Do I need a consultation before laser or peel?", answer: "Yes, the dermatologist reviews your skin type during an initial consultation before starting any procedure." },
      { question: "Do you accept UPI or card payments?", answer: "Yes, UPI and card payments are accepted at reception." },
    ],
  },
  {
    id: "physiotherapy",
    label: "Physiotherapy & Rehab",
    description: "Orthopedic rehab, sports injury, back/neck pain & post-surgery physio",
    default_fee: 700,
    services: [
      { name: "Initial physiotherapy assessment", duration: 45, fee: 800 },
      { name: "Follow-up physiotherapy session", duration: 45, fee: 600 },
      { name: "Back & neck pain therapy", duration: 30, fee: 600 },
      { name: "Sports injury rehab session", duration: 45, fee: 900 },
      { name: "Post-surgery mobility rehab", duration: 45, fee: 800 },
    ],
    faqs: [
      { question: "What should I wear for my physio session?", answer: "Please wear comfortable, loose athletic clothing so the physiotherapist can assess movement easily." },
      { question: "Should I bring my MRI or X-ray reports?", answer: "Yes, please bring any recent scans or doctor referral notes to your first assessment." },
    ],
  },
  {
    id: "general",
    label: "General / Family Clinic",
    description: "Outpatient family medicine, follow-ups, vaccinations & preventive check-ups",
    default_fee: 400,
    services: [
      { name: "General OPD consultation", duration: 15, fee: 400 },
      { name: "Follow-up visit", duration: 15, fee: 250 },
      { name: "Vaccination appointment", duration: 15, fee: 300 },
      { name: "Health check-up report review", duration: 20, fee: 400 },
    ],
    faqs: [
      { question: "Do I need an appointment or are walk-ins allowed?", answer: "Both are welcome. Booking on WhatsApp reserves your preferred time slot and reduces waiting time." },
      { question: "Do you accept UPI or card payments?", answer: "Yes, UPI, cards, and cash are accepted at reception." },
    ],
  },
  {
    id: "eye_ent",
    label: "Eye / ENT Clinic",
    description: "Comprehensive eye exams, contact lens fitting & ENT specialist visits",
    default_fee: 500,
    services: [
      { name: "Comprehensive eye check-up", duration: 30, fee: 500 },
      { name: "Contact lens consultation", duration: 30, fee: 500 },
      { name: "ENT specialist consultation", duration: 20, fee: 600 },
      { name: "Follow-up check-up", duration: 15, fee: 300 },
    ],
    faqs: [
      { question: "Should I bring my current glasses?", answer: "Yes, please bring your current spectacles or prescription for an accurate eye check-up." },
    ],
  },
];

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
    walkin_windows: [],
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
  holds: SlotHold[] = [];
  waitlist: WaitlistEntry[] = [];
  enquiries: Enquiry[] = [];
  leads: SalesLead[] = [];
  audits: AuditLog[] = [];
  reviews: ReviewRecord[] = [];
  voice_calls: VoiceCall[] = [];
  recall_campaigns: RecallCampaign[] = [];
  recall_dispatches: RecallDispatch[] = [];
  queue_tokens: QueueToken[] = [];
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
    this.seq.set("holds", maxId(this.holds));
    this.seq.set("waitlist", maxId(this.waitlist));
    this.seq.set("enquiries", maxId(this.enquiries));
    this.seq.set("leads", maxId(this.leads));
    this.seq.set("audits", maxId(this.audits));
    this.seq.set("reviews", maxId(this.reviews));
    this.seq.set("voice_calls", maxId(this.voice_calls));
    this.seq.set("recall_campaigns", maxId(this.recall_campaigns));
    this.seq.set("recall_dispatches", maxId(this.recall_dispatches));
    this.seq.set("queue_tokens", maxId(this.queue_tokens));
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
        staff_phones: [],
        vertical: "dental",
        google_review_url: "https://g.page/r/demo-dental-clinic/review",
        review_requests_enabled: true,
        voice_pack: "starter_100",
        voice_minutes_included: 100,
        voice_extra_rate: 15,
        voice_cost_per_min: 6,
        voice_alert_threshold_pct: 80,
        booking_mode: "hybrid",
        token_sessions: defaultTokenSessions(),
        widget_enabled: true,
        widget_greeting: "Hello! Ask about fees, timings, or request an appointment below.",
      };
      this.clinics.push(clinic);
      ensureCatalog(clinic);

      const now = nowSec();
      this.voice_calls.push(
        {
          id: this.nextId("voice_calls"),
          clinic_id: clinic.id,
          call_id: "demo-call-101",
          direction: "inbound",
          provider: "demo",
          caller_name: "Ananya Sharma",
          contact: "919848011223",
          duration_seconds: 148,
          billable_minutes: 3,
          outcome: "booking_requested",
          summary: "Asked for teeth cleaning fee (₹1,200) and requested an evening slot with Dr. Demo.",
          transcript:
            "AI: Hello, welcome to Demo Dental Clinic! How can I help you today?\nCaller: Hi, how much is dental scaling and cleaning, and do you have a slot today evening?\nAI: Dental consultation is ₹500 and cleaning starts at ₹1,200. Let me check today's open slots and log your request for reception to confirm.",
          thread_id: null,
          enquiry_id: null,
          started_at: now - 7200,
          ended_at: now - 7052,
          created: now - 7052,
        },
        {
          id: this.nextId("voice_calls"),
          clinic_id: clinic.id,
          call_id: "demo-call-102",
          direction: "outbound",
          provider: "demo",
          caller_name: "Karthik Reddy",
          contact: "919848099887",
          duration_seconds: 54,
          billable_minutes: 1,
          outcome: "reminder_confirmed",
          summary: "Confirmed tomorrow's 11:00 AM root canal consultation appointment.",
          transcript:
            "AI: Hi Karthik, calling from Demo Dental Clinic to confirm your appointment tomorrow at 11:00 AM.\nCaller: Yes, I will be there on time.\nAI: Great, we have marked you confirmed. See you tomorrow!",
          thread_id: null,
          enquiry_id: null,
          started_at: now - 3600,
          ended_at: now - 3546,
          created: now - 3546,
        },
      );
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
