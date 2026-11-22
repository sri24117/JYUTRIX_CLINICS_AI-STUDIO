import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { NextFunction, Request, Response } from "express";
import cookieParser from "cookie-parser";
import {
  APP_MODE,
  Appointment,
  Clinic,
  HttpError,
  KAPSO_API_KEY,
  KAPSO_WEBHOOK_SECRET,
  OPENAI_API_KEY,
  VOICE_TOOL_KEY,
  db,
  defaultSchedule,
  digestToken,
  ensureCatalog,
  hashPassword,
  limitsFor,
  nowSec,
  planName,
  verifyPassword,
} from "./src/store.js";
import {
  asStamp,
  available,
  book,
  cancelReminders,
  localParts,
  parseDateStr,
  readable,
  reschedule,
  toLocalIso,
} from "./src/booking.js";
import {
  OPEN_STATUSES,
  SOURCES,
  STATUSES,
  addEvent,
  applyFollowup,
  asEnquiryDict,
  createManualEnquiry,
  followupQueue,
} from "./src/enquiries.js";
import { inbound, offerWaitlistForSlot, queueReply, takeover } from "./src/receptionist.js";
import { computeReadiness, enableAutomation, setSignoff } from "./src/readiness.js";
import { exportPerformanceCsv, performanceReport, resolvePeriod } from "./src/reports.js";
import { normalizeMetaPayload, verifyKapsoSignature } from "./src/kapso.js";
import {
  CLERK_PUBLISHABLE_KEY,
  isClerkEnabled,
  resolveOrProvisionClerkUser,
  verifyClerkBearerToken,
} from "./src/clerk.js";
import {
  checkDatabaseHealth,
  getDatabaseDialect,
  initPersistence,
  persistState,
} from "./src/persistence.js";
import { runWorkerTick, startWorker } from "./src/worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.resolve(__dirname, "frontend");

const app = express();
app.set("trust proxy", true);
app.use(cookieParser());
app.use(
  express.json({
    limit: "256kb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Security headers (iframe-compatible for AI Studio preview)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

interface Principal {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "owner" | "receptionist";
  clinic_id: number | null;
  csrf: string;
  auth_provider: "clerk" | "local";
}

declare global {
  namespace Express {
    interface Request {
      principal?: Principal;
      rawBody?: Buffer;
    }
  }
}

function isHttps(req: Request): boolean {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return req.secure || proto === "https";
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const secure = isHttps(req);
  res.cookie("jyutrix_session", token, {
    httpOnly: true,
    secure,
    sameSite: secure ? "none" : "lax",
    maxAge: 43200 * 1000,
    path: "/",
  });
}

function clearSessionCookie(req: Request, res: Response): void {
  const secure = isHttps(req);
  res.clearCookie("jyutrix_session", {
    path: "/",
    secure,
    sameSite: secure ? "none" : "lax",
  });
}

async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    // 1. Clerk Bearer JWT authentication
    const authHeader = String(req.headers.authorization || "");
    if (isClerkEnabled() && authHeader.startsWith("Bearer ")) {
      const jwt = authHeader.slice(7).trim();
      const identity = await verifyClerkBearerToken(jwt);
      if (!identity) {
        return next(new HttpError(401, "Invalid or expired Clerk session"));
      }
      const prevUserCount = db.users.length;
      const user = resolveOrProvisionClerkUser(identity);
      if (!user.active) {
        return next(new HttpError(401, "Account inactive"));
      }
      if (db.users.length !== prevUserCount) {
        await persistState();
      }
      req.principal = {
        id: user.id,
        username: user.username,
        email: user.email || identity.email || null,
        role: user.role,
        clinic_id: user.clinic_id,
        csrf: "clerk-bearer",
        auth_provider: "clerk",
      };
      return next();
    }

    // 2. Built-in cookie session + CSRF authentication
    const token = String(req.cookies?.jyutrix_session || "");
    const session = token ? db.sessions.get(digestToken(token)) : undefined;
    if (!session || session.expires <= nowSec()) {
      return next(new HttpError(401, "Please sign in"));
    }
    const user = db.users.find((u) => u.id === session.user_id);
    if (!user || !user.active) {
      return next(new HttpError(401, "Account inactive"));
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const headerCsrf = String(req.headers["x-csrf-token"] || "");
      const a = Buffer.from(headerCsrf, "utf8");
      const b = Buffer.from(session.csrf, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return next(new HttpError(403, "Invalid request token"));
      }
    }
    req.principal = {
      id: user.id,
      username: user.username,
      email: user.email || null,
      role: user.role,
      clinic_id: user.clinic_id,
      csrf: session.csrf,
      auth_provider: "local",
    };
    return next();
  } catch (err) {
    return next(err);
  }
}

function checkScope(user: Principal, clinicId: number): void {
  if (user.role !== "admin" && user.clinic_id !== clinicId) {
    throw new HttpError(404, "Clinic not found");
  }
}

function adminOnly(user: Principal): void {
  if (user.role !== "admin") {
    throw new HttpError(403, "Administrator access required");
  }
}

function ownerOrAdmin(user: Principal): void {
  if (user.role === "receptionist") {
    throw new HttpError(403, "Owner access required");
  }
}

function intParam(value: unknown, name = "id"): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(422, `Invalid ${name}`);
  }
  return n;
}

function clinicDict(c: Clinic) {
  return {
    id: c.id,
    name: c.name,
    doctor: c.doctor,
    phone: c.phone,
    address: c.address,
    timezone: c.timezone,
    fee: c.fee,
    schedule: c.schedule,
    services: c.services,
    faqs: c.faqs,
    number_id: c.number_id,
    enabled: c.enabled,
    template_approved: c.template_approved,
    reminder_buttons_approved: c.reminder_buttons_approved,
    plan: c.plan,
    monthly_fee: c.monthly_fee,
    monthly_limit: c.monthly_limit,
    pilot_end: c.pilot_end,
  };
}

function apptDict(a: Appointment, c: Clinic) {
  const doctor = a.doctor_id ? db.doctors.find((d) => d.id === a.doctor_id) : null;
  const service = a.service_id ? db.services.find((s) => s.id === a.service_id) : null;
  return {
    id: a.id,
    clinic_id: a.clinic_id,
    name: a.name,
    contact: a.contact,
    starts: a.starts,
    ends: a.ends,
    status: a.status,
    source: a.source,
    paid_amount: a.paid_amount,
    reminder_response: a.reminder_response,
    reminder_response_at: a.reminder_response_at,
    doctor_id: a.doctor_id,
    doctor: doctor ? doctor.name : c.doctor,
    service_id: a.service_id,
    service: service ? service.name : "Consultation",
    service_fee: a.service_fee,
    label: readable(c, a.starts),
    consent: a.consent,
  };
}

function wrap(fn: (req: Request, res: Response) => unknown | Promise<unknown>, mutate = false) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res))
      .then(async (result) => {
        if (mutate) {
          await persistState();
        }
        return result;
      })
      .catch(next);
  };
}

// Static frontend & pages
app.get("/", (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "marketing.html"));
});

app.get(["/app", "/app/"], (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

app.use("/static", express.static(FRONTEND_DIR));

// Health check
app.get(
  "/health",
  wrap(async (_req, res) => {
    await checkDatabaseHealth();
    res.json({
      status: "ok",
      database: getDatabaseDialect(),
      mode: APP_MODE,
      clerk_enabled: isClerkEnabled(),
      kapso_configured: Boolean(KAPSO_API_KEY && KAPSO_WEBHOOK_SECRET),
    });
  }),
);

// Public auth configuration (used by frontend to mount Clerk when configured)
app.get("/api/auth/config", (_req, res) => {
  res.json({
    mode: APP_MODE,
    clerk_enabled: isClerkEnabled(),
    clerk_publishable_key: isClerkEnabled() ? CLERK_PUBLISHABLE_KEY : null,
  });
});

// Public sales leads
app.post(
  "/api/leads",
  wrap(async (req, res) => {
    const ip = req.ip || "unknown";
    db.checkRateLimit(`sales-lead:${ip}`, 20, 3600);
    const body = req.body || {};
    if (String(body.website || "").trim()) {
      return res.status(201).json({ ok: true });
    }
    const name = String(body.name || "").trim();
    const clinic_name = String(body.clinic_name || "").trim();
    const city = String(body.city || "").trim();
    const phone = String(body.phone || "").trim();
    const email = String(body.email || "").trim() || null;
    const note = String(body.note || "").trim();
    if (name.length < 2 || clinic_name.length < 2 || city.length < 2 || !phone || !body.consent) {
      throw new HttpError(422, "Please complete all required fields and consent.");
    }
    const lead = {
      id: db.nextId("leads"),
      name,
      clinic_name,
      city,
      phone,
      email,
      note,
      status: "new" as const,
      consent: true,
      created: nowSec(),
    };
    db.leads.push(lead);
    db.audit("public_website", "sales_lead.created", lead.id);
    await persistState();
    res.status(201).json({ ok: true, message: "Thanks — our team will contact you about the demo." });
  }),
);

app.get(
  "/api/leads",
  requireAuth,
  wrap((req, res) => {
    adminOnly(req.principal!);
    res.json([...db.leads].sort((a, b) => b.id - a.id).slice(0, 500));
  }),
);

app.patch(
  "/api/leads/:leadId",
  requireAuth,
  wrap(async (req, res) => {
    adminOnly(req.principal!);
    const leadId = intParam(req.params.leadId, "lead_id");
    const lead = db.leads.find((l) => l.id === leadId);
    if (!lead) throw new HttpError(404, "Lead not found");
    const status = String(req.body?.status || "");
    if (!["new", "contacted", "qualified", "won", "closed"].includes(status)) {
      throw new HttpError(422, "Invalid lead stage");
    }
    lead.status = status as typeof lead.status;
    db.audit(req.principal!.username, "sales_lead.status_changed", lead.id);
    await persistState();
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/leads/:leadId",
  requireAuth,
  wrap(async (req, res) => {
    adminOnly(req.principal!);
    const leadId = intParam(req.params.leadId, "lead_id");
    const idx = db.leads.findIndex((l) => l.id === leadId);
    if (idx === -1) throw new HttpError(404, "Lead not found");
    db.audit(req.principal!.username, "sales_lead.deleted", leadId);
    db.leads.splice(idx, 1);
    await persistState();
    res.json({ ok: true });
  }),
);

// Authentication (local + Clerk)
app.post(
  "/api/auth/login",
  wrap(async (req, res) => {
    const ip = req.ip || "unknown";
    db.checkRateLimit(`login:${ip}`, 30, 300);
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const user = db.users.find(
      (u) => u.username === username || (u.email && u.email.toLowerCase() === username.toLowerCase()),
    );
    const fallback = `${"0".repeat(32)}$${"0".repeat(128)}`;
    const valid = verifyPassword(password, user ? user.password_hash : fallback);
    if (!user || !valid || !user.active) {
      throw new HttpError(401, "Invalid credentials");
    }
    const token = crypto.randomBytes(40).toString("base64url");
    const csrf = crypto.randomBytes(32).toString("base64url");
    db.sessions.set(digestToken(token), {
      token_hash: digestToken(token),
      csrf,
      user_id: user.id,
      expires: nowSec() + 43200,
    });
    db.audit(user.username, "auth.login", user.id, user.clinic_id);
    await persistState();
    setSessionCookie(req, res, token);
    res.json({
      id: user.id,
      csrf,
      username: user.username,
      email: user.email || null,
      role: user.role,
      clinic_id: user.clinic_id,
      mode: APP_MODE,
      auth_provider: "local",
    });
  }),
);

// Self-serve clinic owner registration (used when Clerk is not enabled)
app.post(
  "/api/auth/register",
  wrap(async (req, res) => {
    const ip = req.ip || "unknown";
    db.checkRateLimit(`register:${ip}`, 10, 3600);
    const email = String(req.body?.email || "").trim().toLowerCase();
    const username = String(req.body?.username || email || "").trim();
    const password = String(req.body?.password || "");
    if (username.length < 3 || username.length > 100) {
      throw new HttpError(422, "Username or email must be 3–100 characters");
    }
    if (password.length < 12 || password.length > 128) {
      throw new HttpError(422, "Password must be at least 12 characters");
    }
    if (db.users.some((u) => u.username === username || (email && u.email === email))) {
      throw new HttpError(409, "An account with this username or email already exists");
    }
    const user = {
      id: db.nextId("users"),
      username,
      email: email || null,
      clerk_user_id: null,
      password_hash: hashPassword(password),
      role: "owner" as const,
      clinic_id: null,
      active: true,
    };
    db.users.push(user);
    const token = crypto.randomBytes(40).toString("base64url");
    const csrf = crypto.randomBytes(32).toString("base64url");
    db.sessions.set(digestToken(token), {
      token_hash: digestToken(token),
      csrf,
      user_id: user.id,
      expires: nowSec() + 43200,
    });
    db.audit(user.username, "auth.registered", user.id, null);
    await persistState();
    setSessionCookie(req, res, token);
    res.status(201).json({
      id: user.id,
      csrf,
      username: user.username,
      email: user.email,
      role: user.role,
      clinic_id: null,
      mode: APP_MODE,
      auth_provider: "local",
    });
  }),
);

app.get(
  "/api/auth/me",
  requireAuth,
  wrap((req, res) => {
    res.json({ ...req.principal!, mode: APP_MODE });
  }),
);

app.post(
  "/api/auth/logout",
  requireAuth,
  wrap(async (req, res) => {
    const token = String(req.cookies?.jyutrix_session || "");
    if (token) {
      db.sessions.delete(digestToken(token));
      await persistState();
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }),
);

app.post(
  "/api/auth/password",
  requireAuth,
  wrap(async (req, res) => {
    if (req.principal!.auth_provider === "clerk") {
      throw new HttpError(400, "Manage your password through your Clerk account settings");
    }
    const user = db.users.find((u) => u.id === req.principal!.id);
    if (!user) throw new HttpError(401, "Account not found");
    const current = String(req.body?.current || "");
    const nextPass = String(req.body?.new || "");
    if (!verifyPassword(current, user.password_hash)) {
      throw new HttpError(401, "Current password incorrect");
    }
    if (nextPass.length < 16 || nextPass.length > 128) {
      throw new HttpError(422, "New password must be between 16 and 128 characters");
    }
    user.password_hash = hashPassword(nextPass);
    for (const [k, s] of db.sessions.entries()) {
      if (s.user_id === user.id) db.sessions.delete(k);
    }
    db.audit(req.principal!.username, "auth.password_changed", user.id, user.clinic_id);
    await persistState();
    clearSessionCookie(req, res);
    res.json({ ok: true, sign_in_again: true });
  }),
);

// Self-serve clinic onboarding for newly signed-up owners (Clerk or local)
app.post(
  "/api/onboarding/clinic",
  requireAuth,
  wrap(async (req, res) => {
    const user = db.users.find((u) => u.id === req.principal!.id);
    if (!user) throw new HttpError(401, "Account not found");
    if (user.role !== "admin" && user.clinic_id !== null) {
      throw new HttpError(409, "Your account is already linked to a clinic");
    }
    const b = req.body || {};
    const name = String(b.name || "").trim();
    const doctor = String(b.doctor || "").trim();
    const phone = String(b.phone || "").trim();
    const address = String(b.address || "").trim();
    if (name.length < 2 || doctor.length < 2 || !phone || address.length < 4) {
      throw new HttpError(422, "Clinic name, primary doctor, phone, and address are required");
    }

    const sched = defaultSchedule();
    if (b.open) sched.open = String(b.open);
    if (b.close) sched.close = String(b.close);
    if (b.duration) sched.duration = Math.max(5, Math.min(120, Number(b.duration)));

    const services = Array.isArray(b.services) && b.services.length
      ? b.services.map((s: any) => String(s).trim()).filter(Boolean)
      : ["General consultation"];

    const clinic: Clinic = {
      id: db.nextId("clinics"),
      name,
      doctor,
      phone,
      address,
      timezone: String(b.timezone || "Asia/Kolkata"),
      fee: Math.max(0, Number(b.fee ?? 500)),
      schedule: sched,
      services,
      faqs: [
        {
          question: "Do you accept UPI or card payments?",
          answer: "Yes, UPI and card payments are accepted at reception.",
        },
      ],
      number_id: null,
      enabled: false,
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
    db.clinics.push(clinic);
    ensureCatalog(clinic);

    if (user.role !== "admin") {
      user.clinic_id = clinic.id;
      user.role = "owner";
    }
    db.audit(user.username, "clinic.self_onboarded", clinic.id, clinic.id);
    await persistState();
    res.status(201).json(clinicDict(clinic));
  }),
);

// Clinics
app.get(
  "/api/clinics",
  requireAuth,
  wrap((req, res) => {
    const list =
      req.principal!.role === "admin"
        ? db.clinics
        : db.clinics.filter((c) => c.id === req.principal!.clinic_id);
    res.json([...list].sort((a, b) => a.id - b.id).map(clinicDict));
  }),
);

app.post(
  "/api/clinics",
  requireAuth,
  wrap(async (req, res) => {
    adminOnly(req.principal!);
    const b = req.body || {};
    const clinic: Clinic = {
      id: db.nextId("clinics"),
      name: String(b.name || "").trim(),
      doctor: String(b.doctor || "").trim(),
      phone: String(b.phone || "").trim(),
      address: String(b.address || "").trim(),
      timezone: String(b.timezone || "Asia/Kolkata"),
      fee: Number(b.fee ?? 500),
      schedule: b.schedule || defaultSchedule(),
      services: Array.isArray(b.services) && b.services.length ? b.services : ["General consultation"],
      faqs: Array.isArray(b.faqs) ? b.faqs : [],
      number_id: b.number_id || null,
      enabled: Boolean(b.enabled),
      template_approved: Boolean(b.template_approved),
      reminder_buttons_approved: Boolean(b.reminder_buttons_approved),
      plan: String(b.plan || "Pilot"),
      monthly_fee: Number(b.monthly_fee ?? 4999),
      monthly_limit: Number(b.monthly_limit ?? 2000),
      pilot_end: b.pilot_end ?? null,
      followup_hours: 4,
      baseline: null,
      onboarding: {},
    };
    if (!clinic.name || !clinic.doctor || !clinic.phone || !clinic.address) {
      throw new HttpError(422, "Name, doctor, phone, and address are required");
    }
    db.clinics.push(clinic);
    ensureCatalog(clinic);
    db.audit(req.principal!.username, "clinic.created", clinic.id, clinic.id);
    await persistState();
    res.json(clinicDict(clinic));
  }),
);

app.put(
  "/api/clinics/:clinicId",
  requireAuth,
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");

    const previousPlan = planName(clinic.plan);
    const { doctors, services } = ensureCatalog(clinic);
    const b = req.body || {};
    const targetPlan = req.principal!.role === "admin" && b.plan ? String(b.plan) : clinic.plan;
    const tempClinic = { ...clinic, plan: targetPlan };
    const limits = limitsFor(tempClinic);
    const activeDoctors = db.doctors.filter((d) => d.clinic_id === clinicId && d.active).length;
    const activeServices = db.services.filter((s) => s.clinic_id === clinicId && s.active).length;
    if (activeDoctors > limits.max_doctors || activeServices > limits.max_services) {
      throw new HttpError(409, "Deactivate catalog items above the target plan limits before downgrading");
    }

    clinic.name = String(b.name ?? clinic.name).trim();
    clinic.doctor = String(b.doctor ?? clinic.doctor).trim();
    clinic.phone = String(b.phone ?? clinic.phone).trim();
    clinic.address = String(b.address ?? clinic.address).trim();
    clinic.timezone = String(b.timezone ?? clinic.timezone);
    clinic.fee = Number(b.fee ?? clinic.fee);
    if (b.schedule) clinic.schedule = b.schedule;
    if (Array.isArray(b.services)) clinic.services = b.services;
    if (Array.isArray(b.faqs)) clinic.faqs = b.faqs;
    clinic.enabled = Boolean(b.enabled);
    clinic.template_approved = Boolean(b.template_approved);
    clinic.reminder_buttons_approved = Boolean(b.reminder_buttons_approved);
    if (req.principal!.role === "admin") {
      clinic.number_id = b.number_id || null;
      clinic.plan = targetPlan;
      clinic.monthly_fee = Number(b.monthly_fee ?? clinic.monthly_fee);
      clinic.monthly_limit = Number(b.monthly_limit ?? clinic.monthly_limit);
      clinic.pilot_end = b.pilot_end ?? null;
    }

    if (previousPlan === "Starter") {
      if (doctors[0]) {
        doctors[0].schedule = structuredClone(clinic.schedule);
        doctors[0].name = clinic.doctor;
      }
      if (services[0]) {
        services[0].name = (clinic.services?.[0] || "General consultation").slice(0, 120);
        services[0].fee = clinic.fee;
        services[0].duration = clinic.schedule?.duration || services[0].duration;
      }
    }

    if (!clinic.enabled) {
      for (const thread of db.threads.filter((t) => t.clinic_id === clinicId && t.mode === "bot")) {
        takeover(thread, "Clinic automation disabled", req.principal!.username);
      }
    }
    db.audit(req.principal!.username, "clinic.updated", clinic.id, clinic.id);
    await persistState();
    res.json(clinicDict(clinic));
  }),
);

// Users (admin manages all clinics; owner manages staff in their own clinic)
app.get(
  "/api/users",
  requireAuth,
  wrap((req, res) => {
    ownerOrAdmin(req.principal!);
    const list =
      req.principal!.role === "admin"
        ? db.users
        : db.users.filter((u) => u.clinic_id === req.principal!.clinic_id);
    res.json(
      [...list]
        .sort((a, b) => a.id - b.id)
        .map((u) => ({
          id: u.id,
          username: u.username,
          email: u.email || null,
          role: u.role,
          clinic_id: u.clinic_id,
          active: u.active,
        })),
    );
  }),
);

app.post(
  "/api/users",
  requireAuth,
  wrap(async (req, res) => {
    ownerOrAdmin(req.principal!);
    const b = req.body || {};
    const clinicId =
      req.principal!.role === "admin" ? intParam(b.clinic_id, "clinic_id") : req.principal!.clinic_id!;
    checkScope(req.principal!, clinicId);
    if (!db.clinics.some((c) => c.id === clinicId)) {
      throw new HttpError(404, "Clinic not found");
    }
    const email = String(b.email || "").trim().toLowerCase() || null;
    const username = String(b.username || email || "").trim();
    const password = String(b.password || (isClerkEnabled() ? crypto.randomBytes(24).toString("hex") : ""));
    const role = String(b.role || "receptionist");
    if (username.length < 3 || password.length < 16 || !["owner", "receptionist"].includes(role)) {
      throw new HttpError(422, "Valid username, 16+ char password, and role are required");
    }
    if (db.users.some((u) => u.username === username || (email && u.email === email))) {
      throw new HttpError(409, "Username or email already exists");
    }
    const account = {
      id: db.nextId("users"),
      username,
      email,
      clerk_user_id: null,
      password_hash: hashPassword(password),
      role: role as "owner" | "receptionist",
      clinic_id: clinicId,
      active: true,
    };
    db.users.push(account);
    db.audit(req.principal!.username, "user.created", account.id, account.clinic_id);
    await persistState();
    res.json({ id: account.id, username: account.username, email: account.email, role: account.role });
  }),
);

app.post(
  "/api/users/:userId/disable",
  requireAuth,
  wrap(async (req, res) => {
    ownerOrAdmin(req.principal!);
    const userId = intParam(req.params.userId, "user_id");
    if (userId === req.principal!.id) {
      throw new HttpError(409, "Cannot disable your own account");
    }
    const user = db.users.find((u) => u.id === userId);
    if (!user) throw new HttpError(404, "User not found");
    if (req.principal!.role !== "admin" && user.clinic_id !== req.principal!.clinic_id) {
      throw new HttpError(403, "Cannot manage users outside your clinic");
    }
    user.active = false;
    for (const [k, s] of db.sessions.entries()) {
      if (s.user_id === user.id) db.sessions.delete(k);
    }
    db.audit(req.principal!.username, "user.disabled", user.id, user.clinic_id);
    await persistState();
    res.json({ ok: true });
  }),
);

// Entitlements, Doctors, Services
app.get(
  "/api/clinics/:clinicId/entitlements",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    ensureCatalog(clinic);
    const doctors = db.doctors.filter((d) => d.clinic_id === clinicId && d.active).length;
    const services = db.services.filter((s) => s.clinic_id === clinicId && s.active).length;
    res.json({
      plan: planName(clinic.plan),
      limits: limitsFor(clinic),
      usage: { doctors, services },
    });
  }),
);

app.get(
  "/api/doctors",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    const { doctors } = ensureCatalog(clinic);
    res.json(doctors.map((d) => ({ id: d.id, name: d.name, schedule: d.schedule, active: d.active })));
  }),
);

app.post(
  "/api/clinics/:clinicId/doctors",
  requireAuth,
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    ensureCatalog(clinic);
    const cap = limitsFor(clinic).max_doctors;
    const count = db.doctors.filter((d) => d.clinic_id === clinicId && d.active).length;
    if (count >= cap) {
      throw new HttpError(403, `${planName(clinic.plan)} supports up to ${cap} active doctor(s)`);
    }
    const b = req.body || {};
    const doctor = {
      id: db.nextId("doctors"),
      clinic_id: clinicId,
      name: String(b.name || "").trim(),
      schedule: b.schedule || structuredClone(clinic.schedule),
      active: b.active !== false,
    };
    if (doctor.name.length < 2) throw new HttpError(422, "Doctor name is required");
    db.doctors.push(doctor);
    db.audit(req.principal!.username, "doctor.created", doctor.id, clinicId);
    await persistState();
    res.json({ id: doctor.id, name: doctor.name, schedule: doctor.schedule, active: doctor.active });
  }),
);

app.put(
  "/api/doctors/:doctorId",
  requireAuth,
  wrap(async (req, res) => {
    const doctorId = intParam(req.params.doctorId, "doctor_id");
    const doctor = db.doctors.find((d) => d.id === doctorId);
    if (!doctor) throw new HttpError(404, "Doctor not found");
    checkScope(req.principal!, doctor.clinic_id);
    ownerOrAdmin(req.principal!);
    const clinic = db.clinics.find((c) => c.id === doctor.clinic_id)!;
    const b = req.body || {};
    const active = b.active !== false;
    if (active && !doctor.active) {
      const count = db.doctors.filter((d) => d.clinic_id === clinic.id && d.active).length;
      if (count >= limitsFor(clinic).max_doctors) {
        throw new HttpError(403, "Doctor limit for this plan reached");
      }
    }
    doctor.name = String(b.name ?? doctor.name).trim();
    doctor.schedule = b.schedule || doctor.schedule;
    doctor.active = active;
    db.audit(req.principal!.username, "doctor.updated", doctor.id, clinic.id);
    await persistState();
    res.json({ id: doctor.id, name: doctor.name, schedule: doctor.schedule, active: doctor.active });
  }),
);

app.get(
  "/api/services",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    const { services } = ensureCatalog(clinic);
    res.json(
      services.map((s) => ({ id: s.id, name: s.name, duration: s.duration, fee: s.fee, active: s.active })),
    );
  }),
);

app.post(
  "/api/clinics/:clinicId/services",
  requireAuth,
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    ensureCatalog(clinic);
    const cap = limitsFor(clinic).max_services;
    const count = db.services.filter((s) => s.clinic_id === clinicId && s.active).length;
    if (count >= cap) {
      throw new HttpError(403, `${planName(clinic.plan)} supports up to ${cap} active services`);
    }
    const b = req.body || {};
    const service = {
      id: db.nextId("services"),
      clinic_id: clinicId,
      name: String(b.name || "").trim(),
      duration: Number(b.duration || 30),
      fee: Number(b.fee ?? 500),
      active: b.active !== false,
    };
    if (service.name.length < 2) throw new HttpError(422, "Service name is required");
    db.services.push(service);
    db.audit(req.principal!.username, "service.created", service.id, clinicId);
    await persistState();
    res.json({
      id: service.id,
      name: service.name,
      duration: service.duration,
      fee: service.fee,
      active: service.active,
    });
  }),
);

app.put(
  "/api/services/:serviceId",
  requireAuth,
  wrap(async (req, res) => {
    const serviceId = intParam(req.params.serviceId, "service_id");
    const service = db.services.find((s) => s.id === serviceId);
    if (!service) throw new HttpError(404, "Service not found");
    checkScope(req.principal!, service.clinic_id);
    ownerOrAdmin(req.principal!);
    const clinic = db.clinics.find((c) => c.id === service.clinic_id)!;
    const b = req.body || {};
    const active = b.active !== false;
    if (active && !service.active) {
      const count = db.services.filter((s) => s.clinic_id === clinic.id && s.active).length;
      if (count >= limitsFor(clinic).max_services) {
        throw new HttpError(403, "Service limit for this plan reached");
      }
    }
    service.name = String(b.name ?? service.name).trim();
    service.duration = Number(b.duration ?? service.duration);
    service.fee = Number(b.fee ?? service.fee);
    service.active = active;
    db.audit(req.principal!.username, "service.updated", service.id, clinic.id);
    await persistState();
    res.json({
      id: service.id,
      name: service.name,
      duration: service.duration,
      fee: service.fee,
      active: service.active,
    });
  }),
);

// Availability & Appointments
app.get(
  "/api/availability",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    const day = req.query.day ? parseDateStr(String(req.query.day)).iso : null;
    const doctorId = req.query.doctor_id ? intParam(req.query.doctor_id, "doctor_id") : null;
    const serviceId = req.query.service_id ? intParam(req.query.service_id, "service_id") : null;

    const { doctors, services } = ensureCatalog(clinic);
    const selectedDoctor = doctorId
      ? db.doctors.find((d) => d.id === doctorId)
      : doctors.find((d) => d.active);
    const selectedService = serviceId
      ? db.services.find((s) => s.id === serviceId)
      : services.find((s) => s.active);

    const slots = available(clinic, { targetDate: day, doctorId, serviceId });
    res.json(
      slots.map((s) => ({
        starts: s,
        label: readable(clinic, s),
        iso: toLocalIso(clinic, s),
        doctor_id: selectedDoctor?.id ?? null,
        doctor: selectedDoctor?.name ?? clinic.doctor,
        service_id: selectedService?.id ?? null,
        service: selectedService?.name ?? "Consultation",
        fee: selectedService?.fee ?? clinic.fee,
      })),
    );
  }),
);

app.get(
  "/api/appointments",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    const list = db.appointments
      .filter((a) => a.clinic_id === clinicId)
      .sort((a, b) => b.starts - a.starts)
      .slice(0, 500);
    res.json(list.map((a) => apptDict(a, clinic)));
  }),
);

app.post(
  "/api/appointments",
  requireAuth,
  wrap(async (req, res) => {
    const b = req.body || {};
    const clinicId = intParam(b.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");

    const contact = String(b.contact || "").trim().replace(/^\+/, "");
    const name = String(b.name || "").trim();
    if (!name || !contact || !b.scheduled_at) {
      throw new HttpError(422, "Name, phone, and appointment slot are required");
    }
    const thread =
      db.threads.find((t) => t.clinic_id === clinic.id && t.contact === contact && t.channel === "whatsapp") ||
      null;
    if (b.consent && thread && !thread.opted_out) {
      thread.consent = true;
    }
    const a = book(
      clinic,
      thread,
      asStamp(String(b.scheduled_at), clinic),
      `manual:${clinic.id}:${b.request_key || crypto.randomUUID()}`,
      {
        source: "staff",
        name,
        contact,
        consent: Boolean(b.consent) && !(thread && thread.opted_out),
        doctorId: b.doctor_id ? Number(b.doctor_id) : null,
        serviceId: b.service_id ? Number(b.service_id) : null,
      },
    );
    db.audit(req.principal!.username, "appointment.staff_created", a.id, clinic.id);
    if (thread && !thread.opted_out) {
      const doctor = a.doctor_id ? db.doctors.find((d) => d.id === a.doctor_id) : null;
      const service = a.service_id ? db.services.find((s) => s.id === a.service_id) : null;
      queueReply(
        clinic,
        thread,
        `Appointment #${a.id} confirmed for ${readable(clinic, a.starts)} with ${doctor ? doctor.name : clinic.doctor}, ${service ? service.name : "Consultation"}. Reply CANCEL or STAFF for changes.`,
        `manual-confirm:${a.id}`,
        "staff",
      );
      void runWorkerTick();
    }
    await persistState();
    res.json(apptDict(a, clinic));
  }),
);

app.patch(
  "/api/appointments/:appointmentId",
  requireAuth,
  wrap(async (req, res) => {
    const appointmentId = intParam(req.params.appointmentId, "appointment_id");
    const a = db.appointments.find((x) => x.id === appointmentId);
    if (!a) throw new HttpError(404, "Appointment not found");
    checkScope(req.principal!, a.clinic_id);
    const c = db.clinics.find((x) => x.id === a.clinic_id)!;
    const b = req.body || {};

    if (b.status === "confirmed" && a.status !== "confirmed") {
      throw new HttpError(409, "Create a new booking to reactivate a closed appointment");
    }
    if (b.scheduled_at || b.doctor_id || b.service_id) {
      if (a.status !== "confirmed") {
        throw new HttpError(409, "Only confirmed appointments can be rescheduled");
      }
      const oldStart = a.starts;
      const oldDoctorId = a.doctor_id;
      const oldServiceId = a.service_id;
      const starts = b.scheduled_at ? asStamp(String(b.scheduled_at), c) : a.starts;
      reschedule(
        c,
        a,
        starts,
        b.doctor_id ? Number(b.doctor_id) : null,
        b.service_id ? Number(b.service_id) : null,
      );
      if (oldStart !== a.starts || oldDoctorId !== a.doctor_id || oldServiceId !== a.service_id) {
        offerWaitlistForSlot(c, oldStart, oldDoctorId, oldServiceId, a.source === "demo");
      }
    }
    if (b.status) {
      if (!["confirmed", "completed", "no_show", "cancelled"].includes(b.status)) {
        throw new HttpError(422, "Invalid status");
      }
      a.status = b.status;
      if (a.status !== "confirmed") cancelReminders(a);
      if (a.status === "cancelled") {
        offerWaitlistForSlot(c, a.starts, a.doctor_id, a.service_id, a.source === "demo");
      }
    }
    if (b.paid_amount !== undefined && b.paid_amount !== null) {
      a.paid_amount = Number(b.paid_amount);
    }
    db.audit(req.principal!.username, "appointment.updated", a.id, c.id);
    const thread = a.thread_id ? db.threads.find((t) => t.id === a.thread_id) : null;
    if (thread && thread.channel === "whatsapp" && !thread.opted_out && (b.scheduled_at || b.status === "cancelled")) {
      queueReply(
        c,
        thread,
        `Appointment #${a.id}: ${a.status}, ${readable(c, a.starts)}. Reply STAFF for help.`,
        `update:${a.id}:${crypto.randomUUID()}`,
        "staff",
      );
      void runWorkerTick();
    }
    await persistState();
    res.json(apptDict(a, c));
  }),
);

// Conversations / Threads
app.get(
  "/api/threads",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const list = db.threads
      .filter((t) => t.clinic_id === clinicId)
      .sort((a, b) => b.updated - a.updated)
      .slice(0, 200);
    res.json(
      list.map((t) => {
        const last = db.messages
          .filter((m) => m.thread_id === t.id)
          .sort((a, b) => b.id - a.id)[0];
        return {
          id: t.id,
          name: t.name,
          contact: t.contact,
          mode: t.mode,
          channel: t.channel,
          attention: t.attention,
          updated: t.updated,
          consent: t.consent,
          opted_out: t.opted_out,
          last: last ? last.text : "",
        };
      }),
    );
  }),
);

function getScopedThread(threadId: number, user: Principal) {
  const t = db.threads.find((x) => x.id === threadId);
  if (!t) throw new HttpError(404, "Conversation not found");
  checkScope(user, t.clinic_id);
  return t;
}

app.get(
  "/api/threads/:threadId/messages",
  requireAuth,
  wrap((req, res) => {
    const t = getScopedThread(intParam(req.params.threadId, "thread_id"), req.principal!);
    const msgs = db.messages
      .filter((m) => m.thread_id === t.id)
      .sort((a, b) => a.id - b.id)
      .slice(0, 500);
    res.json(
      msgs.map((m) => ({
        id: m.id,
        direction: m.direction,
        text: m.text,
        status: m.status,
        created: m.created,
      })),
    );
  }),
);

app.post(
  "/api/threads/:threadId/takeover",
  requireAuth,
  wrap(async (req, res) => {
    const t = getScopedThread(intParam(req.params.threadId, "thread_id"), req.principal!);
    takeover(t, "Staff handling conversation", req.principal!.username);
    await persistState();
    res.json({ ok: true });
  }),
);

app.post(
  "/api/threads/:threadId/resume",
  requireAuth,
  wrap(async (req, res) => {
    const t = getScopedThread(intParam(req.params.threadId, "thread_id"), req.principal!);
    t.mode = "bot";
    t.state = {};
    t.attention = "";
    t.generation += 1;
    db.audit(req.principal!.username, "conversation.resumed", t.id, t.clinic_id);
    await persistState();
    res.json({ ok: true });
  }),
);

app.post(
  "/api/threads/:threadId/reply",
  requireAuth,
  wrap(async (req, res) => {
    const t = getScopedThread(intParam(req.params.threadId, "thread_id"), req.principal!);
    const text = String(req.body?.text || "").trim();
    if (!text) throw new HttpError(422, "Reply text required");
    if (t.opted_out) throw new HttpError(409, "Patient opted out");
    if (t.channel === "whatsapp" && t.last_inbound < nowSec() - 86400) {
      throw new HttpError(409, "24-hour reply window closed");
    }
    const c = db.clinics.find((x) => x.id === t.clinic_id)!;
    takeover(t, "Staff handling conversation", req.principal!.username);
    queueReply(c, t, text, `staff:${crypto.randomUUID()}`, "staff");
    t.updated = nowSec();
    await persistState();
    void runWorkerTick();
    res.json({ ok: true });
  }),
);

app.delete(
  "/api/threads/:threadId/patient",
  requireAuth,
  wrap(async (req, res) => {
    const t = getScopedThread(intParam(req.params.threadId, "thread_id"), req.principal!);
    ownerOrAdmin(req.principal!);
    const cid = t.clinic_id;
    const contact = t.contact;
    const tids = new Set(db.threads.filter((x) => x.clinic_id === cid && x.contact === contact).map((x) => x.id));
    for (const a of db.appointments.filter((x) => x.clinic_id === cid && x.contact === contact)) {
      cancelReminders(a);
      a.name = "Deleted patient";
      a.contact = "deleted";
      a.thread_id = null;
      a.consent = false;
    }
    db.jobs = db.jobs.filter(
      (j) => !(j.clinic_id === cid && ((j.thread_id && tids.has(j.thread_id)) || j.payload?.contact === contact)),
    );
    db.enquiries = db.enquiries.filter((e) => !(e.clinic_id === cid && e.contact === contact));
    db.messages = db.messages.filter((m) => !tids.has(m.thread_id));
    db.threads = db.threads.filter((x) => !tids.has(x.id));
    db.audit(req.principal!.username, "patient.erased", t.id, cid);
    await persistState();
    res.json({ ok: true });
  }),
);

// Enquiries & Follow-ups
app.get(
  "/api/enquiries",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    if (!db.clinics.some((c) => c.id === clinicId)) throw new HttpError(404, "Clinic not found");
    const status = req.query.status ? String(req.query.status) : null;
    const source = req.query.source ? String(req.query.source) : null;
    const assignedTo = req.query.assigned_to ? String(req.query.assigned_to) : null;
    const overdue = String(req.query.overdue || "") === "true";
    const q = req.query.q ? String(req.query.q).trim().toLowerCase() : "";
    const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 500));

    if (status && !(STATUSES as readonly string[]).includes(status)) {
      throw new HttpError(422, "Unknown status");
    }
    if (source && !(SOURCES as readonly string[]).includes(source)) {
      throw new HttpError(422, "Unknown source");
    }

    const now = nowSec();
    const all = db.enquiries.filter((e) => e.clinic_id === clinicId);
    const counts: Record<string, number> = { new: 0, contacted: 0, interested: 0, booked: 0, lost: 0 };
    for (const e of all) counts[e.status] = (counts[e.status] || 0) + 1;
    const overdueCount = all.filter(
      (e) =>
        (OPEN_STATUSES as readonly string[]).includes(e.status) &&
        e.next_followup !== null &&
        e.next_followup <= now,
    ).length;

    let rows = all;
    if (status) rows = rows.filter((e) => e.status === status);
    if (source) rows = rows.filter((e) => e.source === source);
    if (assignedTo === "unassigned") rows = rows.filter((e) => e.assigned_to === null);
    else if (assignedTo) rows = rows.filter((e) => e.assigned_to === assignedTo);
    if (overdue) {
      rows = rows.filter(
        (e) =>
          (OPEN_STATUSES as readonly string[]).includes(e.status) &&
          e.next_followup !== null &&
          e.next_followup <= now,
      );
    }
    if (q) {
      rows = rows.filter((e) => e.name.toLowerCase().includes(q) || e.contact.toLowerCase().includes(q));
    }
    rows = [...rows].sort((a, b) => b.last_activity - a.last_activity).slice(0, limit);

    res.json({
      items: rows.map((e) => asEnquiryDict(e, now)),
      counts,
      overdue: overdueCount,
    });
  }),
);

app.post(
  "/api/enquiries",
  requireAuth,
  wrap(async (req, res) => {
    const b = req.body || {};
    const clinicId = intParam(b.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    const name = String(b.name || "").trim();
    const contact = String(b.contact || "").trim();
    const source = String(b.source || "phone");
    if (!name || !contact || !(SOURCES as readonly string[]).includes(source)) {
      throw new HttpError(422, "Name, phone, and valid source are required");
    }
    const { enquiry, created } = createManualEnquiry(
      clinic,
      {
        name,
        contact,
        source: source as "whatsapp" | "website" | "phone" | "walk_in",
        service_interest: String(b.service_interest || "").trim(),
        note: String(b.note || "").trim(),
      },
      req.principal!.username,
    );
    db.audit(
      req.principal!.username,
      created ? "enquiry.created" : "enquiry.merged",
      enquiry.id,
      clinic.id,
    );
    await persistState();
    res.json({ ...asEnquiryDict(enquiry), created });
  }),
);

app.patch(
  "/api/enquiries/:enquiryId",
  requireAuth,
  wrap(async (req, res) => {
    const enquiryId = intParam(req.params.enquiryId, "enquiry_id");
    const e = db.enquiries.find((x) => x.id === enquiryId);
    if (!e) throw new HttpError(404, "Enquiry not found");
    checkScope(req.principal!, e.clinic_id);
    const b = req.body || {};
    const actor = req.principal!.username;
    const now = nowSec();

    if ("assigned_to" in b && b.assigned_to !== e.assigned_to) {
      if (b.assigned_to !== null) {
        const assignee = db.users.find(
          (u) =>
            u.username === b.assigned_to &&
            u.active &&
            (u.clinic_id === e.clinic_id || u.role === "admin"),
        );
        if (!assignee) throw new HttpError(422, "Assign to an active user of this clinic");
      }
      addEvent(e, "assigned", `Assigned to ${b.assigned_to || "nobody"}`, actor);
      e.assigned_to = b.assigned_to;
    }
    if (b.service_interest !== undefined && b.service_interest !== null) {
      e.service_interest = String(b.service_interest);
    }
    if (b.status && b.status !== e.status) {
      if (b.status === "booked") {
        throw new HttpError(409, "Create an appointment to mark an enquiry as booked");
      }
      if (!(STATUSES as readonly string[]).includes(b.status)) {
        throw new HttpError(422, "Unknown status");
      }
      addEvent(e, "status", `${e.status} → ${b.status}`, actor);
      e.status = b.status;
      if (b.status === "lost") {
        e.next_followup = null;
      } else if (!("next_followup" in b) && e.next_followup && e.next_followup <= now) {
        e.next_followup = null;
      }
    }
    if ("next_followup" in b) {
      e.next_followup = ["booked", "lost"].includes(e.status)
        ? null
        : b.next_followup === null
          ? null
          : Number(b.next_followup);
    }
    e.last_activity = now;
    db.audit(actor, "enquiry.updated", e.id, e.clinic_id);
    await persistState();
    res.json(asEnquiryDict(e, now));
  }),
);

app.post(
  "/api/enquiries/:enquiryId/notes",
  requireAuth,
  wrap(async (req, res) => {
    const enquiryId = intParam(req.params.enquiryId, "enquiry_id");
    const e = db.enquiries.find((x) => x.id === enquiryId);
    if (!e) throw new HttpError(404, "Enquiry not found");
    checkScope(req.principal!, e.clinic_id);
    const text = String(req.body?.text || "").trim();
    if (!text) throw new HttpError(422, "Note text is required");
    addEvent(e, "note", text, req.principal!.username);
    e.last_activity = nowSec();
    db.audit(req.principal!.username, "enquiry.note_added", e.id, e.clinic_id);
    await persistState();
    res.json(asEnquiryDict(e));
  }),
);

app.get(
  "/api/followups",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    res.json(followupQueue(clinic));
  }),
);

app.post(
  "/api/enquiries/:enquiryId/followup",
  requireAuth,
  wrap(async (req, res) => {
    const enquiryId = intParam(req.params.enquiryId, "enquiry_id");
    const e = db.enquiries.find((x) => x.id === enquiryId);
    if (!e) throw new HttpError(404, "Enquiry not found");
    checkScope(req.principal!, e.clinic_id);
    const clinic = db.clinics.find((c) => c.id === e.clinic_id)!;
    const b = req.body || {};
    applyFollowup(
      clinic,
      e,
      String(b.outcome || ""),
      b.next_in_days !== undefined && b.next_in_days !== null ? Number(b.next_in_days) : null,
      String(b.note || "").trim(),
      req.principal!.username,
    );
    await persistState();
    res.json(asEnquiryDict(e));
  }),
);

app.put(
  "/api/clinics/:clinicId/followup-settings",
  requireAuth,
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    const hours = Number(req.body?.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
      throw new HttpError(422, "Hours must be between 1 and 168");
    }
    clinic.followup_hours = Math.round(hours);
    db.audit(req.principal!.username, "clinic.followup_hours_set", clinic.id, clinic.id);
    await persistState();
    res.json({ followup_hours: clinic.followup_hours });
  }),
);

// Waitlist
app.get(
  "/api/waitlist",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    if (!limitsFor(clinic).waitlist) {
      throw new HttpError(403, "Waitlist is available on the Growth plan");
    }
    const list = db.waitlist
      .filter((e) => e.clinic_id === clinicId)
      .sort((a, b) => b.created - a.created)
      .slice(0, 500);
    res.json(
      list.map((entry) => ({
        id: entry.id,
        name: entry.name,
        contact: entry.contact,
        status: entry.status,
        created: entry.created,
        expires: entry.expires,
        offered_starts: entry.offered_starts,
        doctor:
          (entry.offered_doctor_id && db.doctors.find((d) => d.id === entry.offered_doctor_id)?.name) ||
          "Any doctor",
        service:
          (entry.offered_service_id && db.services.find((s) => s.id === entry.offered_service_id)?.name) ||
          "Any service",
      })),
    );
  }),
);

app.post(
  "/api/waitlist/:entryId/cancel",
  requireAuth,
  wrap(async (req, res) => {
    const entryId = intParam(req.params.entryId, "entry_id");
    const entry = db.waitlist.find((e) => e.id === entryId);
    if (!entry) throw new HttpError(404, "Waitlist entry not found");
    checkScope(req.principal!, entry.clinic_id);
    const clinic = db.clinics.find((c) => c.id === entry.clinic_id)!;
    const released =
      entry.status === "offered" && entry.offered_starts
        ? ([entry.offered_starts, entry.offered_doctor_id, entry.offered_service_id] as const)
        : null;
    entry.status = "cancelled";
    entry.expires = null;
    db.audit(req.principal!.username, "waitlist.cancelled", entry.id, clinic.id);
    if (released) {
      offerWaitlistForSlot(clinic, released[0], released[1], released[2]);
    }
    await persistState();
    res.json({ ok: true });
  }),
);

// Demo conversation
app.post(
  "/api/demo/message",
  requireAuth,
  wrap(async (req, res) => {
    if (APP_MODE === "production") {
      throw new HttpError(404, "Demo disabled in production");
    }
    const b = req.body || {};
    const clinicId = intParam(b.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic) throw new HttpError(404, "Clinic not found");
    const contact = String(b.contact || "").trim();
    const name = String(b.name || "Demo patient").trim();
    const text = String(b.text || "").trim();
    if (!contact || !text) throw new HttpError(422, "Contact and message text are required");
    const { thread, reply } = inbound(clinic, contact, name, text, crypto.randomUUID(), { channel: "demo" });
    await persistState();
    res.json({ thread_id: thread.id, reply, mode: thread.mode, state: thread.state });
  }),
);

// Kapso Meta-format WhatsApp webhook
app.post(
  "/webhooks/kapso/:clinicId",
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}), "utf8");
    const sig = String(req.headers["x-webhook-signature"] || "");
    if (!verifyKapsoSignature(raw, sig)) {
      throw new HttpError(401, "Invalid signature");
    }
    const body = req.body;
    if (!body || typeof body !== "object" || !Array.isArray(body.entry)) {
      throw new HttpError(422, "Configure a Kapso kind=meta webhook; expected Meta entry payload");
    }
    const records = normalizeMetaPayload(body);
    const rawIdem = String(req.headers["x-idempotency-key"] || "") || crypto.createHash("sha256").update(raw).digest("hex");
    const deliveryKey = crypto.createHash("sha256").update(`${clinicId}:${rawIdem}`).digest("hex");

    const clinic = db.clinics.find((c) => c.id === clinicId);
    if (!clinic || !clinic.number_id) {
      throw new HttpError(404, "Clinic number not configured");
    }
    if (records.length > 100) {
      throw new HttpError(422, "Too many events in one delivery");
    }
    if (db.deliveries.has(deliveryKey)) {
      return res.json({ ok: true, duplicate: true });
    }

    const now = nowSec();
    const rank: Record<string, number> = {
      queued: 0,
      accepted: 1,
      sent: 2,
      delivered: 3,
      read: 4,
      failed: -1,
    };

    for (const r of records) {
      if (r.number_id !== clinic.number_id) {
        throw new HttpError(403, "Webhook number does not match clinic");
      }
      if (!r.provider_id) {
        throw new HttpError(422, "Message id required");
      }
      if (r.type === "inbound") {
        if (!r.contact) throw new HttpError(422, "Sender identity required");
        const jobKey = `inbound:${clinic.id}:${r.provider_id}`;
        const existsJob = db.jobs.some((j) => j.key === jobKey);
        const existsMsg = db.messages.some((m) => m.provider_id === r.provider_id);
        if (!existsJob && !existsMsg) {
          db.jobs.push({
            id: db.nextId("jobs"),
            clinic_id: clinic.id,
            thread_id: null,
            appointment_id: null,
            key: jobKey,
            kind: "inbound",
            status: "pending",
            attempts: 0,
            due: now,
            error: "",
            message_id: null,
            payload: r,
            created: now,
          });
        }
      } else if (["sent", "delivered", "read", "failed"].includes(r.status)) {
        const msg = db.messages.find((m) => {
          if (m.provider_id !== r.provider_id) return false;
          const th = db.threads.find((t) => t.id === m.thread_id);
          return th?.clinic_id === clinicId;
        });
        if (msg) {
          if (
            (r.status === "failed" && !["delivered", "read"].includes(msg.status)) ||
            (rank[r.status] ?? 0) > (rank[msg.status] ?? 0)
          ) {
            msg.status = r.status;
          }
          for (const job of db.jobs.filter((j) => j.message_id === msg.id)) {
            job.status = msg.status;
            if (msg.status === "failed") {
              job.error = "Provider reported delivery failure";
              const th = db.threads.find((t) => t.id === msg.thread_id);
              if (th) th.attention = job.error;
            }
          }
        }
      }
    }

    db.deliveries.add(deliveryKey);
    await persistState();
    void runWorkerTick();
    res.json({ ok: true, accepted: records.length });
  }),
);

// Jobs
app.get(
  "/api/jobs",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    res.json(
      db.jobs
        .filter((j) => j.clinic_id === clinicId)
        .sort((a, b) => b.id - a.id)
        .slice(0, 200)
        .map((j) => ({
          id: j.id,
          kind: j.kind,
          status: j.status,
          attempts: j.attempts,
          due: j.due,
          error: j.error,
          thread_id: j.thread_id,
        })),
    );
  }),
);

app.post(
  "/api/jobs/:jobId/retry",
  requireAuth,
  wrap(async (req, res) => {
    const jobId = intParam(req.params.jobId, "job_id");
    const job = db.jobs.find((j) => j.id === jobId);
    if (!job) throw new HttpError(404, "Job not found");
    checkScope(req.principal!, job.clinic_id);
    if (!["failed", "uncertain"].includes(job.status)) {
      throw new HttpError(409, "Job is not failed or uncertain");
    }
    if (job.status === "uncertain" && !req.body?.reviewed_provider_logs) {
      throw new HttpError(
        409,
        "Review provider logs and acknowledge the send did not succeed before retrying",
      );
    }
    job.status = "pending";
    job.due = nowSec();
    job.attempts = 0;
    job.error = "";
    db.audit(req.principal!.username, "job.retry", job.id, job.clinic_id);
    await persistState();
    void runWorkerTick();
    res.json({ ok: true });
  }),
);

// Overview & Performance Reports
app.get(
  "/api/reports",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const c = db.clinics.find((x) => x.id === clinicId);
    if (!c) throw new HttpError(404, "Clinic not found");
    const appts = db.appointments.filter((a) => a.clinic_id === clinicId && a.source !== "demo");
    const today = localParts(c.timezone, nowSec()).dateStr;
    const threads = db.threads.filter((t) => t.clinic_id === clinicId && t.channel !== "demo");
    const now = new Date();
    const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0) / 1000);
    const usage = db.jobs.filter(
      (j) =>
        j.clinic_id === clinicId &&
        ["outbound", "reminder"].includes(j.kind) &&
        ["accepted", "sent", "delivered", "read", "uncertain"].includes(j.status) &&
        j.created >= monthStart,
    ).length;

    res.json({
      enquiries: threads.length,
      booked: appts.length,
      attended: appts.filter((a) => a.status === "completed").length,
      no_shows: appts.filter((a) => a.status === "no_show").length,
      today: appts.filter((a) => a.status === "confirmed" && localParts(c.timezone, a.starts).dateStr === today).length,
      needs_attention: threads.filter((t) => Boolean(t.attention)).length,
      recorded_payments: appts.reduce((sum, a) => sum + (a.paid_amount || 0), 0),
      estimated_booking_value: appts
        .filter((a) => ["confirmed", "completed"].includes(a.status))
        .reduce((sum, a) => sum + (a.service_id ? a.service_fee : c.fee), 0),
      monthly_messages: usage,
      monthly_limit: c.monthly_limit,
      definition:
        "Operational totals across all retained live data. Bookings include staff bookings; payments are staff recorded, not payment-gateway verified. No incremental revenue claim.",
    });
  }),
);

app.get(
  "/api/reports/performance",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const c = db.clinics.find((x) => x.id === clinicId);
    if (!c) throw new HttpError(404, "Clinic not found");
    const period = String(req.query.period || "30d");
    const start = req.query.start ? String(req.query.start) : null;
    const end = req.query.end ? String(req.query.end) : null;
    const window = resolvePeriod(c, period, start, end);
    res.json(performanceReport(c, window));
  }),
);

app.get(
  "/api/reports/export",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    const c = db.clinics.find((x) => x.id === clinicId);
    if (!c) throw new HttpError(404, "Clinic not found");
    const period = String(req.query.period || "30d");
    const start = req.query.start ? String(req.query.start) : null;
    const end = req.query.end ? String(req.query.end) : null;
    const window = resolvePeriod(c, period, start, end);
    const data = performanceReport(c, window);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="jyutrix-report-${data.period.key}.csv"`);
    res.send(exportPerformanceCsv(data, c.name));
  }),
);

app.put(
  "/api/clinics/:clinicId/baseline",
  requireAuth,
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    const c = db.clinics.find((x) => x.id === clinicId);
    if (!c) throw new HttpError(404, "Clinic not found");
    const b = req.body || {};
    c.baseline = {
      enquiries_per_week: b.enquiries_per_week ?? null,
      bookings_per_week: b.bookings_per_week ?? null,
      no_show_percent: b.no_show_percent ?? null,
      set_on: nowSec(),
    };
    db.audit(req.principal!.username, "clinic.baseline_set", c.id, c.id);
    await persistState();
    res.json(c.baseline);
  }),
);

// Readiness / Go-live setup
app.get(
  "/api/clinics/:clinicId/readiness",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    const c = db.clinics.find((x) => x.id === clinicId);
    if (!c) throw new HttpError(404, "Clinic not found");
    res.json(computeReadiness(c));
  }),
);

app.put(
  "/api/clinics/:clinicId/onboarding/:key",
  requireAuth,
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    const c = db.clinics.find((x) => x.id === clinicId);
    if (!c) throw new HttpError(404, "Clinic not found");
    setSignoff(c, String(req.params.key), Boolean(req.body?.done), req.principal!.username);
    await persistState();
    res.json(computeReadiness(c));
  }),
);

app.post(
  "/api/clinics/:clinicId/enable-automation",
  requireAuth,
  wrap(async (req, res) => {
    const clinicId = intParam(req.params.clinicId, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    const c = db.clinics.find((x) => x.id === clinicId);
    if (!c) throw new HttpError(404, "Clinic not found");
    enableAutomation(c, req.principal!.username);
    await persistState();
    res.json(computeReadiness(c));
  }),
);

// System status & Audit
app.get(
  "/api/status",
  requireAuth,
  wrap((_req, res) => {
    res.json({
      mode: APP_MODE,
      database: getDatabaseDialect(),
      worker_healthy: db.workerHeartbeat > nowSec() - 60,
      kapso_configured: Boolean(KAPSO_API_KEY && KAPSO_WEBHOOK_SECRET),
      kapso_live_verified: false,
      clerk_enabled: isClerkEnabled(),
      ai_mode: OPENAI_API_KEY ? "approved FAQ semantic matching" : "approved rules and exact FAQs",
      voice_tools_configured: Boolean(VOICE_TOOL_KEY),
      voice_telephony_connected: false,
    });
  }),
);

app.get(
  "/api/audit",
  requireAuth,
  wrap((req, res) => {
    const clinicId = intParam(req.query.clinic_id, "clinic_id");
    checkScope(req.principal!, clinicId);
    ownerOrAdmin(req.principal!);
    res.json(
      db.audits
        .filter((a) => a.clinic_id === clinicId)
        .sort((a, b) => b.id - a.id)
        .slice(0, 100)
        .map((a) => ({
          actor: a.actor,
          action: a.action,
          target: a.target,
          created: a.created,
        })),
    );
  }),
);

// Error handler
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ detail: err.detail });
  }
  console.error("[Jyutrix] Unhandled error:", err);
  res.status(500).json({ detail: "Internal server error" });
});

async function main() {
  await initPersistence();
  db.bootstrap();
  await persistState();
  startWorker();

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `Jyutrix Clinic Reception running on http://0.0.0.0:${PORT} (mode=${APP_MODE}, db=${getDatabaseDialect()}, clerk=${isClerkEnabled() ? "on" : "off"})`,
    );
  });
}

main().catch((err) => {
  console.error("[Jyutrix] Fatal startup error:", err);
  process.exit(1);
});
