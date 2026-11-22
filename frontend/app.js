"use strict";
const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const money = (v) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(v || 0);
const stamp = (v) => (v ? new Date(v * 1000).toLocaleString("en-IN") : "");
const state = {
  user: null,
  clinics: [],
  clinic: null,
  view: "overview",
  threads: [],
  appts: [],
  jobs: [],
  leads: [],
  doctors: [],
  services: [],
  entitlements: {},
  report: {},
  status: {},
  selectedThread: null,
  enquiries: { items: [], counts: {}, overdue: 0 },
  enquiryFilters: { status: "", source: "", owner: "", overdue: false, q: "" },
  reportPeriod: { period: "30d", start: "", end: "" },
  performance: null,
  followups: null,
  readiness: null,
};
let refreshTimer, toastTimer;
let clerkInstance = null;
let authConfig = { clerk_enabled: false, clerk_publishable_key: null, mode: "demo" };

function clerkFrontendApiFromKey(pk) {
  try {
    const raw = pk.replace(/^pk_(test|live)_/, "");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    return atob(padded).replace(/\$$/, "");
  } catch {
    return "";
  }
}

async function getClerkToken() {
  if (!clerkInstance || !clerkInstance.session) return null;
  try {
    return await clerkInstance.session.getToken();
  } catch {
    return null;
  }
}

async function initClerk(publishableKey) {
  if (!publishableKey) return null;
  if (clerkInstance) return clerkInstance;
  const fapi = clerkFrontendApiFromKey(publishableKey);
  if (!fapi) return null;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.crossOrigin = "anonymous";
    script.setAttribute("data-clerk-publishable-key", publishableKey);
    script.src = `https://${fapi}/npm/@clerk/clerk-js@latest/dist/clerk.browser.js`;
    script.onload = resolve;
    script.onerror = () => reject(new Error("Could not load Clerk authentication script"));
    document.head.appendChild(script);
  });
  if (!window.Clerk) return null;
  await window.Clerk.load();
  clerkInstance = window.Clerk;
  return clerkInstance;
}

function mountClerkLogin() {
  if (!clerkInstance) return;
  const target = $("#clerk-auth");
  if (!target) return;
  target.hidden = false;
  $("#local-auth-wrap").hidden = true;
  target.innerHTML = "";
  clerkInstance.mountSignIn(target, {
    fallbackRedirectUrl: "/app",
    signUpFallbackRedirectUrl: "/app",
  });
}

function toast(text, error = false) {
  $("#toast").textContent = text;
  $("#toast").className = error ? "error" : "";
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 6000);
}
async function api(path, options = {}) {
  const token = await getClerkToken();
  const headers = {
    "Content-Type": "application/json",
    "X-CSRF-Token": state.user?.csrf || "",
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = { detail: "Server response could not be read" };
  }
  if (!response.ok) {
    if (response.status === 401 && state.user) showLogin();
    const detail = Array.isArray(data.detail)
      ? data.detail
          .map((d) => {
            const field = d.loc?.slice(1).join(".");
            const message = String(d.msg).replace(/^Value error, /, "");
            return field ? `${field}: ${message}` : message;
          })
          .join("; ")
      : data.detail;
    throw Error(detail || "Request failed");
  }
  return data;
}
function post(path, data = {}) {
  return api(path, { method: "POST", body: JSON.stringify(data) });
}
function showLogin() {
  state.user = null;
  $("#workspace").hidden = true;
  $("#login").hidden = false;
  clearInterval(refreshTimer);
  if (authConfig.clerk_enabled && clerkInstance && !clerkInstance.user) {
    mountClerkLogin();
  }
}
function pill(text, type = "") {
  return `<span class="pill ${type}">${esc(text)}</span>`;
}
function empty(title, body = "") {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(body)}</p></div>`;
}
const titles = {
  overview: "Overview",
  appointments: "Appointments",
  inbox: "Conversations",
  delivery: "Message delivery",
  settings: "Clinic settings",
  demo: "Try the demo",
  leads: "Sales enquiries",
  waitlist: "Cancellation waitlist",
  enquiries: "Patient enquiries",
  reports: "Performance",
  followups: "Follow-ups",
  setup: "Go-live setup",
};
async function launch() {
  state.clinics = await api("/api/clinics");
  state.clinic =
    state.clinics.find((c) => c.id === state.clinic?.id) ||
    state.clinics[0] ||
    null;
  $("#clinic-select").innerHTML = state.clinics
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
    .join("");
  if (state.clinic) $("#clinic-select").value = state.clinic.id;
  $("#login").hidden = true;
  $("#workspace").hidden = false;
  $("#account").textContent = `${state.user.username} · ${state.user.role}`;
  $("#environment").textContent =
    state.user.mode === "production"
      ? "CLINIC WORKSPACE"
      : "DEMO WORKSPACE · NO REAL DEMO SENDS";
  $("#demo-nav").hidden = state.user.mode === "production";
  $("#leads-nav").hidden = state.user.role !== "admin";
  await load();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (
      !document.hidden &&
      !$("#modal").open &&
      state.view !== "settings" &&
      state.view !== "demo"
    )
      load(false).catch((e) => toast(e.message, true));
  }, 15000);
}
async function load(render = true) {
  if (!state.clinic) {
    renderView();
    return;
  }
  const id = state.clinic.id;
  const results = await Promise.all([
    api(`/api/threads?clinic_id=${id}`),
    api(`/api/appointments?clinic_id=${id}`),
    api(`/api/jobs?clinic_id=${id}`),
    api(`/api/reports?clinic_id=${id}`),
    api("/api/status"),
    api(`/api/clinics/${id}/entitlements`),
    api(`/api/followups?clinic_id=${id}`),
  ]);
  if (state.clinic.id !== id) return;
  [state.threads, state.appts, state.jobs, state.report, state.status, state.entitlements, state.followups] =
    results;
  // Readiness changes only when someone acts on it, so it is not part of the 15-second refresh.
  if (render || state.view === "setup" || !state.readiness || state.readiness.clinic_id !== id) {
    state.readiness = await api(`/api/clinics/${id}/readiness`);
    paintSetupBadge();
  }
  const dueNow = state.followups.counts.overdue + state.followups.counts.today;
  $("#followup-count").textContent = dueNow || "";
  $("#followup-count").title = dueNow ? `${state.followups.counts.overdue} overdue · ${state.followups.counts.today} due today` : "";
  $("#waitlist-nav").hidden = !state.entitlements.limits?.waitlist;
  $("#attention-count").textContent =
    state.threads.filter((t) => t.attention).length || "";
  const missing = [];
  if (!state.status.worker_healthy)
    missing.push("Message worker is offline. Queued messages will wait.");
  if (!state.status.kapso_configured)
    missing.push("WhatsApp credentials are not configured.");
  if (!state.clinic.number_id)
    missing.push("Connect this clinic’s WhatsApp number before activation.");
  if (!state.clinic.enabled)
    missing.push("Automation is paused for this clinic.");
  $("#connection-banner").hidden = !missing.length;
  $("#connection-banner").textContent = missing.join(" ");
  if (render || !["settings", "demo"].includes(state.view)) {
    if (state.view === "inbox" && !render) {
      renderThreadList();
      await renderMessages();
    } else if (state.view === "enquiries" && !render && $("#enquiry-rows")) {
      await refreshEnquiries();
    } else if (state.view === "reports" && !render && $("#report-body")) {
      await refreshReport();
    } else if (state.view === "followups" && !render && $("#followup-sections")) {
      paintFollowups();
    } else renderView();
  }
}
function renderView() {
  document
    .querySelectorAll("nav button")
    .forEach((b) =>
      b.classList.toggle("active", b.dataset.view === state.view),
    );
  $("#page-title").textContent = titles[state.view];
  if (state.view === "leads" && state.user.role === "admin") {
    renderLeads();
    return;
  }
  if (!state.clinic) {
    if (state.user.role === "admin") {
      $("#content").innerHTML =
        `<div class="panel">${empty("Add your first clinic", "Create a clinic profile, approve its information, then connect WhatsApp.")}<button class="primary" data-action="new-clinic">Add clinic</button></div>`;
      return;
    }
    $("#page-title").textContent = "Set up your clinic";
    $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>Welcome to Jyutrix</h3><p>Enter your clinic’s reception details to create your workspace and open the Go-live setup checklist.</p></div></div><form id="onboarding-clinic-form"><div class="form-grid"><label>Clinic name<input name="name" placeholder="Smile Care Dental" required minlength="2" maxlength="120"></label><label>Primary doctor<input name="doctor" placeholder="Dr. Rao" required minlength="2" maxlength="120"></label><label>Clinic phone / WhatsApp<input name="phone" placeholder="+919876543210" required></label><label>Consultation fee (₹)<input name="fee" type="number" min="0" value="500" required></label><label class="full">Clinic address<input name="address" placeholder="Street, area, city" required minlength="4" maxlength="600"></label><label>Timezone<select name="timezone"><option value="Asia/Kolkata" selected>Asia/Kolkata</option><option value="UTC">UTC</option></select></label><label>Appointment slot duration (minutes)<input name="duration" type="number" min="5" max="120" value="30" required></label><label>Reception opens<input name="open" type="time" value="09:00" required></label><label>Reception closes<input name="close" type="time" value="19:00" required></label><label class="full">Approved services (one per line)<textarea name="services">General consultation\nFollow-up visit</textarea></label></div><div class="form-actions"><button class="primary">Create clinic workspace →</button></div></form></section>`;
    return;
  }
  ({
    overview: renderOverview,
    appointments: renderAppointments,
    inbox: renderInbox,
    delivery: renderDelivery,
    settings: renderSettings,
    demo: renderDemo,
    waitlist: renderWaitlist,
    enquiries: renderEnquiries,
    reports: renderReports,
    followups: renderFollowups,
    setup: renderSetup,
  })[state.view]();
}
function renderOverview() {
  const c = state.clinic,
    r = state.report;
  const today = state.appts.filter(
    (a) =>
      a.source !== "demo" &&
      a.status === "confirmed" &&
      new Date(a.starts * 1000).toLocaleDateString("en-CA", {
        timeZone: c.timezone,
      }) === new Date().toLocaleDateString("en-CA", { timeZone: c.timezone }),
  );
  const attention = state.threads.filter((t) => t.attention).slice(0, 5);
  $("#content").innerHTML =
    `<section class="hero"><div><div class="eyebrow">RECEPTION, WITH ROOM TO BREATHE</div><h2>Welcome to ${esc(c.name)}.</h2><p>Keep appointments moving and give the conversations that need a person a clear next step.</p><div class="status-line">${pill(c.enabled ? "Automation enabled" : "Automation paused", c.enabled ? "good" : "warn")}${pill(c.number_id ? "Number configured" : "WhatsApp setup needed", c.number_id ? "" : "warn")}${pill(c.timezone)}</div></div><div class="hero-icon">◌</div></section><div class="metrics">${[
      ["Today’s appointments", r.today, "Confirmed · live records"],
      ["Needs attention", r.needs_attention, "Patient conversations"],
      ["Attended visits", r.attended, "Staff marked completed"],
      [
        "Payments recorded",
        money(r.recorded_payments),
        "Entered by clinic staff",
      ],
    ]
      .map(
        ([l, v, s]) =>
          `<div class="metric"><p>${l}</p><strong>${esc(v ?? 0)}</strong><small>${s}</small></div>`,
      )
      .join(
        "",
      )}</div><div class="two-col"><section class="panel"><div class="panel-heading"><div><h3>On the schedule</h3><p>Today · ${esc(c.doctor)}</p></div><button class="quiet" data-view="appointments">View all →</button></div>${
      today.length
        ? today
            .slice(0, 5)
            .map(
              (a) =>
                `<div class="list-row"><div><strong>${esc(a.name)}</strong><p>${esc(a.label)}</p></div>${pill(a.status, "good")}</div>`,
            )
            .join("")
        : empty(
            "A clear schedule",
            "Live appointments appear here. Demo records stay separate.",
          )
    }</section><section class="panel"><div class="panel-heading"><div><h3>Needs a human touch</h3><p>Staff requests and delivery issues</p></div><button class="quiet" data-view="inbox">Open inbox →</button></div>${attention.length ? attention.map((t) => `<div class="list-row"><div><strong>${esc(t.name)}</strong><p>${esc(t.attention)}</p></div><button class="secondary" data-action="open-thread" data-id="${t.id}">Open</button></div>`).join("") : empty("Nothing waiting", "New staff requests will appear here.")}</section></div><section class="panel"><div class="panel-heading"><div><h3>Your clinic’s activity</h3><p>Live records only · totals across retained data</p></div></div><div class="metrics"><div><p>Patient enquiries</p><h2>${r.enquiries || 0}</h2></div><div><p>Bookings created</p><h2>${r.booked || 0}</h2></div><div><p>No-shows recorded</p><h2>${r.no_shows || 0}</h2></div><div><p>Messages this month</p><h2>${r.monthly_messages || 0} <small>/ ${r.monthly_limit || 0}</small></h2></div></div><p class="hint">${esc(r.definition || "")}</p></section>`;
}
function renderAppointments() {
  const rows = state.appts;
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-heading"><div><h3>A shared schedule</h3><p>Add phone and walk-in bookings here to keep WhatsApp availability accurate.</p></div><button class="primary" data-action="new-appointment">+ Book appointment</button></div><div class="toolbar"><input id="appointment-search" placeholder="Search patient or contact" aria-label="Search appointments"><select id="appointment-filter" class="status-filter" aria-label="Filter appointments"><option value="">All statuses</option>${["confirmed", "completed", "no_show", "cancelled"].map((s) => `<option>${s}</option>`).join("")}</select><button class="secondary" data-action="export">Export CSV</button></div><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Appointment</th><th>Status</th><th>Source</th><th>Actions</th></tr></thead><tbody id="appointment-rows">${rows.map((a) => appointmentRow(a)).join("")}</tbody></table></div>${!rows.length ? empty("No appointments yet", "Book manually, or let patients choose and confirm a WhatsApp slot.") : ""}</section>`;
}
function appointmentRow(a) {
  return `<tr data-search="${esc((a.name + " " + a.contact).toLowerCase())}" data-status="${a.status}"><td><strong>${esc(a.name)}</strong><small>${esc(a.contact)}</small></td><td>${esc(a.label)}<small>${esc(a.doctor || "")} · ${esc(a.service || "")}</small><small>#${a.id}${a.paid_amount ? " · " + money(a.paid_amount) : ""}${a.reminder_response && a.reminder_response !== "pending" ? " · reminder: " + esc(a.reminder_response.replaceAll("_", " ")) : ""}</small></td><td>${pill(a.status, a.status === "confirmed" || a.status === "completed" ? "good" : "")}</td><td>${pill(a.source, a.source === "demo" ? "warn" : "")}</td><td><div class="actions">${a.status === "confirmed" ? `<button class="secondary" data-action="complete" data-id="${a.id}">Complete</button><button class="secondary" data-action="reschedule" data-id="${a.id}">Move</button><button class="quiet" data-action="no-show" data-id="${a.id}">No-show</button><button class="danger" data-action="cancel" data-id="${a.id}">Cancel</button>` : ""}<button class="quiet" data-action="payment" data-id="${a.id}">Record payment</button></div></td></tr>`;
}
function renderInbox() {
  if (!state.threads.find((t) => t.id === state.selectedThread))
    state.selectedThread = state.threads[0]?.id || null;
  $("#content").innerHTML =
    `<div class="inbox-layout"><div id="thread-list" class="thread-list"></div><section class="panel chat-panel" id="conversation"></section></div>`;
  renderThreadList();
  renderMessages().catch((e) => toast(e.message, true));
}
function renderThreadList() {
  if (!$("#thread-list")) return;
  $("#thread-list").innerHTML = state.threads.length
    ? state.threads
        .map(
          (t) =>
            `<button class="thread-item ${t.id === state.selectedThread ? "selected" : ""}" data-action="open-thread" data-id="${t.id}"><div><strong>${esc(t.name)}</strong>${pill(t.channel === "demo" ? "Demo" : t.mode, t.mode === "human" ? "warn" : "")}</div><p>${esc(t.attention || t.last)}</p><small>${esc(t.contact)}</small></button>`,
        )
        .join("")
    : empty("No conversations", "Incoming patient messages appear here.");
}
async function renderMessages() {
  const t = state.threads.find((t) => t.id === state.selectedThread);
  if (!$("#conversation")) return;
  if (!t) {
    $("#conversation").innerHTML = empty(
      "A conversation starts here",
      "Select a patient to see the history and reply.",
    );
    return;
  }
  const id = t.id;
  const messages = await api(`/api/threads/${id}/messages`);
  if (state.selectedThread !== id || !$("#conversation")) return;
  const draft = $("#reply-text")?.value || "";
  $("#conversation").innerHTML =
    `<div class="chat-header"><div class="panel-heading"><div><h3>${esc(t.name)}</h3><p>${esc(t.contact)} · ${esc(t.channel)}</p></div><div class="actions"><button class="secondary" data-action="${t.mode === "human" ? "resume" : "takeover"}" data-id="${id}">${t.mode === "human" ? "Resume automation" : "Take over"}</button>${state.user.role !== "receptionist" ? `<button class="danger" data-action="erase" data-id="${id}">Delete patient data</button>` : ""}</div></div>${t.attention ? `<p class="hint">${esc(t.attention)}</p>` : ""}<div class="status-line">${pill(t.mode === "human" ? "Staff in control" : "Automated replies", t.mode === "human" ? "warn" : "good")}${pill(t.opted_out ? "Messages stopped" : t.consent ? "Reminders permitted" : "No reminder permission")}</div></div><div class="chat-stream" id="chat-stream">${messages.map((m) => `<div class="bubble ${m.direction}">${esc(m.text)}<small>${esc(stamp(m.created))} · ${esc(m.status)}</small></div>`).join("")}</div><div class="chat-reply"><form id="reply-form"><input id="reply-text" name="text" placeholder="Write a reply…" required maxlength="4000" aria-label="Reply" ${t.opted_out ? "disabled" : ""}><button class="primary" ${t.opted_out ? "disabled" : ""}>Send reply</button></form><p class="hint">Sending a reply takes over the conversation.${t.channel === "demo" ? " This is a local demo; nothing is sent." : ""}</p></div>`;
  $("#reply-text").value = draft;
  $("#chat-stream").scrollTop = $("#chat-stream").scrollHeight;
}
function renderDelivery() {
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-heading"><div><h3>Every message, accounted for</h3><p>Accepted means the provider accepted the send; delivered/read receipts arrive separately.</p></div>${pill(state.status.worker_healthy ? "Worker online" : "Worker offline", state.status.worker_healthy ? "good" : "bad")}</div><div class="table-wrap"><table><thead><tr><th>Job</th><th>State</th><th>Next attempt / due</th><th>Details</th><th></th></tr></thead><tbody>${state.jobs.map((j) => `<tr><td>#${j.id}<small>${esc(j.kind)}</small></td><td>${pill(j.status, ["failed", "uncertain"].includes(j.status) ? "bad" : "")}</td><td>${esc(stamp(j.due))}<small>${j.attempts} attempt(s)</small></td><td>${esc(j.error || "—")}</td><td>${["failed", "uncertain"].includes(j.status) ? `<button class="secondary" data-action="retry" data-id="${j.id}">Review & retry</button>` : ""}</td></tr>`).join("")}</tbody></table></div>${!state.jobs.length ? empty("No queued messages", "WhatsApp replies and reminders are tracked here.") : ""}<p class="hint">An uncertain send is never automatically retried. Check Kapso logs before sending again to avoid duplicates.</p></section>`;
}
function clinicFields(c = {}) {
  const s = c.schedule || {
    open: "09:00",
    close: "19:00",
    duration: 30,
    closed_days: [6],
    breaks: [{ start: "13:00", end: "14:00" }],
    leave_dates: [],
  };
  return `<div class="form-grid"><label>Clinic name<input name="name" value="${esc(c.name || "")}" required maxlength="120"></label><label>Doctor name<input name="doctor" value="${esc(c.doctor || "")}" required maxlength="120"></label><label>Clinic phone<input name="phone" value="${esc(c.phone || "")}" placeholder="+919…" required></label><label>Consultation fee (₹)<input name="fee" type="number" min="0" value="${c.fee ?? 500}" required></label><label class="full">Address<input name="address" value="${esc(c.address || "")}" required maxlength="600"></label><label>Timezone<select name="timezone">${["Asia/Kolkata", "UTC"].map((z) => `<option ${c.timezone === z ? "selected" : ""}>${z}</option>`).join("")}</select></label><label>Appointment duration (minutes)<input name="duration" type="number" min="5" max="120" value="${s.duration}" required></label><label>Opens<input name="open" type="time" value="${s.open}" required></label><label>Closes<input name="close" type="time" value="${s.close}" required></label><label>Break starts (optional)<input name="break_start" type="time" value="${s.breaks[0]?.start || ""}"></label><label>Break ends<input name="break_end" type="time" value="${s.breaks[0]?.end || ""}"></label><div class="full"><label>Closed days</label><div class="status-line">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<label class="check-label"><input type="checkbox" name="closed_days" value="${i}" ${s.closed_days.includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div></div><label class="full">Leave dates (one YYYY-MM-DD per line)<textarea name="leave_dates">${esc(s.leave_dates.join("\n"))}</textarea></label><label class="full">Approved service descriptions (one per line)<textarea name="services">${esc((c.services || ["Dental consultation"]).join("\n"))}</textarea><p class="hint">Patient-facing approved descriptions. Booking duration and fee are configured separately in Growth scheduling below.</p></label><label>WhatsApp phone number ID<input name="number_id" value="${esc(c.number_id || "")}" placeholder="From Kapso" ${state.user.role !== "admin" ? "disabled" : ""}></label><label>Monthly outgoing message allowance<input name="monthly_limit" type="number" min="1" value="${c.monthly_limit ?? 2000}" ${state.user.role !== "admin" ? "disabled" : ""}></label><label>Plan<select name="plan" ${state.user.role !== "admin" ? "disabled" : ""}>${["Pilot", "Starter", "Growth"].map((p) => `<option value="${p}" ${(c.plan || "Pilot") === p ? "selected" : ""}>${p}</option>`).join("")}</select></label><label>Monthly subscription (₹)<input name="monthly_fee" type="number" min="0" value="${c.monthly_fee ?? 4999}" ${state.user.role !== "admin" ? "disabled" : ""}></label><label>Plan expiry (optional)<input name="pilot_end" type="date" value="${c.pilot_end ? new Date(c.pilot_end * 1000).toISOString().slice(0, 10) : ""}" ${state.user.role !== "admin" ? "disabled" : ""}></label><div class="status-line"><label class="check-label"><input name="enabled" type="checkbox" ${c.enabled ? "checked" : ""}>Enable automated replies</label><label class="check-label"><input name="template_approved" type="checkbox" ${c.template_approved ? "checked" : ""}>Reminder template approved</label><label class="check-label"><input name="reminder_buttons_approved" type="checkbox" ${c.reminder_buttons_approved ? "checked" : ""}>Quick-reply reminder template approved</label><p class="hint">Quick replies require a separate approved template with Confirm, Reschedule and Cancel buttons. See docs/KAPSO.md before enabling.</p></div><div class="full"><label>Approved questions & answers</label><p class="hint">Only add administrative answers approved by the clinic.</p><div id="faq-rows">${(c.faqs || []).map((f) => faqRow(f)).join("")}</div><button type="button" class="secondary" data-action="add-faq">+ Add answer</button></div></div>`;
}
function faqRow(f = {}) {
  return `<div class="faq-row"><input class="faq-question" value="${esc(f.question || "")}" placeholder="Patient question" aria-label="FAQ question" required maxlength="300"><textarea class="faq-answer" placeholder="Approved answer" aria-label="FAQ answer" required maxlength="1200">${esc(f.answer || "")}</textarea><button type="button" class="quiet" data-action="remove-faq" aria-label="Remove answer">✕</button></div>`;
}
function readClinic(form) {
  const d = new FormData(form),
    old = state.clinic || {};
  return {
    name: d.get("name"),
    doctor: d.get("doctor"),
    phone: d.get("phone"),
    address: d.get("address"),
    timezone: d.get("timezone"),
    fee: Number(d.get("fee")),
    schedule: {
      open: d.get("open"),
      close: d.get("close"),
      duration: Number(d.get("duration")),
      closed_days: d.getAll("closed_days").map(Number),
      breaks: d.get("break_start")
        ? [{ start: d.get("break_start"), end: d.get("break_end") }]
        : [],
      leave_dates: String(d.get("leave_dates"))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    services: String(d.get("services"))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    faqs: [...form.querySelectorAll(".faq-row")].map((row) => ({
      question: row.querySelector("input").value,
      answer: row.querySelector("textarea").value,
    })),
    number_id:
      state.user.role === "admin" ? d.get("number_id") || null : old.number_id,
    enabled: d.has("enabled"),
    template_approved: d.has("template_approved"),
    reminder_buttons_approved: d.has("reminder_buttons_approved"),
    plan: state.user.role === "admin" ? d.get("plan") : old.plan,
    monthly_fee:
      state.user.role === "admin"
        ? Number(d.get("monthly_fee"))
        : old.monthly_fee,
    monthly_limit:
      state.user.role === "admin"
        ? Number(d.get("monthly_limit"))
        : old.monthly_limit,
    pilot_end:
      state.user.role === "admin"
        ? d.get("pilot_end")
          ? Math.floor(
              new Date(d.get("pilot_end") + "T23:59:59Z").getTime() / 1000,
            )
          : null
        : old.pilot_end,
  };
}
function doctorFormHtml(doctor = {}) {
  const schedule = doctor.schedule || state.clinic.schedule;
  return `<form id="growth-doctor-form" data-id="${doctor.id || ""}"><div class="form-grid"><label>Doctor name<input name="name" value="${esc(doctor.name || "")}" required minlength="2" maxlength="120"></label><label>Opens<input name="open" type="time" value="${schedule.open}" required></label><label>Closes<input name="close" type="time" value="${schedule.close}" required></label><label>Appointment duration (minutes)<input name="duration" type="number" min="5" max="120" value="${schedule.duration}" required></label><label>Break starts<input name="break_start" type="time" value="${schedule.breaks[0]?.start || ""}"></label><label>Break ends<input name="break_end" type="time" value="${schedule.breaks[0]?.end || ""}"></label><div class="full"><label>Closed days</label><div class="status-line">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<label class="check-label"><input type="checkbox" name="closed_days" value="${i}" ${(schedule.closed_days || []).includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div></div><label class="full">Leave dates (one YYYY-MM-DD per line)<textarea name="leave_dates">${esc((schedule.leave_dates || []).join("\n"))}</textarea></label><label class="check-label"><input type="checkbox" name="active" ${doctor.active === false ? "" : "checked"}> Active for new bookings</label></div><div class="form-actions"><button class="primary">Save doctor</button></div></form>`;
}
function serviceFormHtml(service = {}) {
  return `<form id="growth-service-form" data-id="${service.id || ""}"><div class="form-grid"><label>Service name<input name="name" value="${esc(service.name || "")}" required minlength="2" maxlength="120"></label><label>Duration (minutes)<input name="duration" type="number" min="5" max="240" value="${service.duration || 30}" required></label><label>Consultation fee (₹)<input name="fee" type="number" min="0" max="100000" value="${service.fee ?? 500}" required></label><label class="check-label"><input type="checkbox" name="active" ${service.active === false ? "" : "checked"}> Active for new bookings</label></div><div class="form-actions"><button class="primary">Save service</button></div></form>`;
}
function readDoctorForm(form) {
  const data = new FormData(form);
  return {
    name: data.get("name"),
    active: data.has("active"),
    schedule: {
      open: data.get("open"),
      close: data.get("close"),
      duration: Number(data.get("duration")),
      closed_days: data.getAll("closed_days").map(Number),
      breaks: data.get("break_start") ? [{ start: data.get("break_start"), end: data.get("break_end") }] : [],
      leave_dates: String(data.get("leave_dates")).split("\n").map((s) => s.trim()).filter(Boolean),
    },
  };
}
async function renderGrowthCatalog() {
  const target = $("#growth-catalog-content");
  if (!target) return;
  try {
    const clinicId = state.clinic.id;
    const [entitlements, doctors, services] = await Promise.all([
      api(`/api/clinics/${clinicId}/entitlements`),
      api(`/api/doctors?clinic_id=${clinicId}`),
      api(`/api/services?clinic_id=${clinicId}`),
    ]);
    state.entitlements = entitlements;
    state.doctors = doctors;
    state.services = services;
    if (!$("#growth-catalog-content")) return;
    const editable = state.user.role !== "receptionist";
    const canAddDoctor = editable && entitlements.usage.doctors < entitlements.limits.max_doctors;
    const canAddService = editable && entitlements.usage.services < entitlements.limits.max_services;
    target.innerHTML = `<div class="status-line">${pill(`${entitlements.plan} plan`)}${pill(`${entitlements.usage.doctors}/${entitlements.limits.max_doctors} doctors`)}${pill(`${entitlements.usage.services}/${entitlements.limits.max_services} services`)}</div><p class="hint">Growth supports up to five active doctors with doctor-specific schedules. Your current plan caps are enforced on the server. The cancellation waitlist is available on Growth; payment links are not available yet.</p><div class="two-col"><section><div class="panel-heading"><h3>Doctors</h3>${editable ? `<button class="secondary" data-action="new-doctor" ${canAddDoctor ? "" : "disabled title=\"Plan doctor limit reached\""}>+ Add doctor</button>` : ""}</div>${doctors.map((doctor) => `<div class="list-row"><div><strong>${esc(doctor.name)}</strong><p>${esc(doctor.schedule.open)}–${esc(doctor.schedule.close)} · ${doctor.schedule.duration} min · ${doctor.active ? "active" : "inactive"}</p></div>${editable ? `<button class="secondary" data-action="edit-doctor" data-id="${doctor.id}">Edit</button>` : ""}</div>`).join("")}</section><section><div class="panel-heading"><h3>Services</h3>${editable ? `<button class="secondary" data-action="new-service" ${canAddService ? "" : "disabled title=\"Plan service limit reached\""}>+ Add service</button>` : ""}</div>${services.map((service) => `<div class="list-row"><div><strong>${esc(service.name)}</strong><p>${service.duration} min · ${money(service.fee)} · ${service.active ? "active" : "inactive"}</p></div>${editable ? `<button class="secondary" data-action="edit-service" data-id="${service.id}">Edit</button>` : ""}</div>`).join("")}</section></div>`;
  } catch (error) {
    toast(error.message, true);
  }
}

function renderSettings() {
  const c = state.clinic;
  const canManageStaff = state.user.role === "admin" || state.user.role === "owner";
  const showPasswordPanel = state.user.auth_provider !== "clerk";
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-heading"><div><h3>Approved clinic information</h3><p>This information guides patient replies and appointment availability.</p></div>${state.user.role === "admin" ? '<button class="secondary" data-action="new-clinic">+ Add clinic</button>' : ""}</div>${state.user.role === "receptionist" ? '<p class="hint">Ask the clinic owner to update settings.</p>' : `<form id="settings-form">${clinicFields(c)}<div class="form-actions"><button class="primary">Save clinic settings</button><p class="hint">Schedule changes affect new bookings. Review existing appointments separately.</p></div></form>`}</section><section class="panel"><h3>WhatsApp activation</h3><div class="setup-step"><span>1</span><div><strong>Connect the clinic’s number in Kapso</strong><p>Use the clinic-owned account. Save its phone number ID above.</p></div></div><div class="setup-step"><span>2</span><div><strong>Register the clinic webhook</strong><p>Use the Meta payload option and the secret configured on the server. Your deployment guide contains the setup command.</p></div></div><div class="setup-step"><span>3</span><div><strong>Approve the reminder template and test</strong><p>Check booking, cancellation, staff takeover and message delivery from a real patient number before activation.</p></div></div><div class="status-line">${pill(state.status.kapso_configured ? "Credentials configured" : "Credentials missing", state.status.kapso_configured ? "good" : "warn")}${pill(state.status.database === "postgresql" ? "PostgreSQL connected" : "In-memory demo storage", state.status.database === "postgresql" ? "good" : "warn")}${pill(state.status.ai_mode)}</div></section><section class="panel"><div class="panel-heading"><div><h3>Growth scheduling</h3><p>Manage doctor-specific availability and service durations.</p></div></div><div id="growth-catalog-content"><p class="hint">Loading Growth plan details…</p></div></section>${canManageStaff ? `<section class="panel"><div class="panel-heading"><h3>Clinic staff access</h3><button class="secondary" data-action="new-user">+ Add staff account</button></div><div id="users-list"></div></section>` : ""}${showPasswordPanel ? `<section class="panel password-panel"><h3>Change your password</h3><form id="password-form"><div class="form-grid"><label>Current password<input name="current" type="password" required autocomplete="current-password"></label><label>New password (16+ characters)<input name="new" type="password" required minlength="16" maxlength="128" autocomplete="new-password"></label></div><div class="form-actions"><button class="secondary">Change password & sign out</button></div></form></section>` : ""}`;
  renderGrowthCatalog();
  if (canManageStaff)
    api("/api/users")
      .then((users) => {
        if (!$("#users-list")) return;
        $("#users-list").innerHTML = users
          .map(
            (u) =>
              `<div class="list-row"><div><strong>${esc(u.username)}</strong>${u.email ? ` <small>${esc(u.email)}</small>` : ""}<p>${esc(u.role)} · clinic ${u.clinic_id ?? "all"} · ${u.active ? "active" : "disabled"}</p></div>${u.id !== state.user.id && u.active ? `<button class="danger" data-action="disable-user" data-id="${u.id}">Disable</button>` : ""}</div>`,
          )
          .join("");
      })
      .catch((e) => toast(e.message, true));
}
function renderWaitlist() {
  $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>Cancellation waitlist</h3><p>Consenting patients can receive one expiring offer when a suitable appointment opens.</p></div><button class="secondary" id="waitlist-refresh">Refresh</button></div><div id="waitlist-rows">Loading waitlist…</div><p class="hint">Offers are sent only when the patient has consented and a WhatsApp reply window is open. Otherwise the clinic must use its approved template and follow-up process. A waitlist offer is not a booked appointment.</p></section>`;
  api(`/api/waitlist?clinic_id=${state.clinic.id}`)
    .then((entries) => {
      const target = $("#waitlist-rows");
      if (!target || state.view !== "waitlist") return;
      if (!entries.length) {
        target.innerHTML = empty("No waitlist requests", "Patients can message WAITLIST and confirm consent to join.");
        return;
      }
      target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Patient</th><th>State</th><th>Offer</th><th>Joined</th><th></th></tr></thead><tbody>${entries.map((entry) => `<tr><td><strong>${esc(entry.name)}</strong><small>${esc(entry.contact)}</small></td><td>${pill(entry.status, entry.status === "waiting" ? "warn" : entry.status === "booked" ? "good" : "")}</td><td>${entry.offered_starts ? `${esc(stamp(entry.offered_starts))}<small>${esc(entry.doctor)} · ${esc(entry.service)} · expires ${esc(stamp(entry.expires))}</small>` : "—"}</td><td>${esc(stamp(entry.created))}</td><td>${["waiting", "offered"].includes(entry.status) ? `<button class="danger" data-action="cancel-waitlist" data-id="${entry.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
    })
    .catch((error) => toast(error.message, true));
}

function renderLeads() {
  $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>Website demo requests</h3><p>Keep sales follow-up in one place. Only administrator accounts can access these enquiries.</p></div></div><div id="leads-list">Loading enquiries…</div><p class="hint">Contact people only about their demo request. Delete records when no longer needed or when deletion is requested.</p></section>`;
  api("/api/leads")
    .then((leads) => {
      state.leads = leads;
      const target = $("#leads-list");
      if (!target || state.view !== "leads") return;
      if (!leads.length) {
        target.innerHTML = empty("No demo requests yet", "Requests submitted on the public Jyutrix site will appear here.");
        return;
      }
      target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Contact</th><th>Clinic</th><th>Request</th><th>Received</th><th>Stage</th><th></th></tr></thead><tbody>${leads.map((lead) => `<tr><td><strong>${esc(lead.name)}</strong><small><a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>${lead.email ? `<br><a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>` : ""}</small></td><td>${esc(lead.clinic_name)}<small>${esc(lead.city)}</small></td><td>${esc(lead.note || "—")}</td><td>${esc(stamp(lead.created))}</td><td><select data-lead-id="${lead.id}" aria-label="Follow-up stage for ${esc(lead.name)}">${["new", "contacted", "qualified", "won", "closed"].map((stage) => `<option value="${stage}" ${stage === lead.status ? "selected" : ""}>${stage}</option>`).join("")}</select></td><td><button class="danger" data-action="delete-lead" data-id="${lead.id}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
    })
    .catch((error) => toast(error.message, true));
}

const ENQUIRY_STATUSES = ["new", "contacted", "interested", "booked", "lost"];
const SOURCE_LABELS = { whatsapp: "WhatsApp", website: "Website", phone: "Phone", walk_in: "Walk-in" };
const dayInput = (epoch) => {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function enquiryQuery() {
  const f = state.enquiryFilters;
  const p = new URLSearchParams({ clinic_id: String(state.clinic.id) });
  if (f.status) p.set("status", f.status);
  if (f.source) p.set("source", f.source);
  if (f.owner === "me") p.set("assigned_to", state.user.username);
  else if (f.owner) p.set("assigned_to", f.owner);
  if (f.overdue) p.set("overdue", "true");
  if (f.q.trim()) p.set("q", f.q.trim());
  return p.toString();
}
function enquiryChips() {
  const c = state.enquiries.counts || {},
    f = state.enquiryFilters;
  const chip = (label, count, attrs, active, tone = "") =>
    `<button type="button" class="chip ${active ? "active" : ""} ${tone}" data-action="enquiry-chip" ${attrs} aria-pressed="${active}">${esc(label)} <b>${count ?? 0}</b></button>`;
  return [
    chip("All", Object.values(c).reduce((a, b) => a + b, 0), 'data-status=""', !f.status && !f.overdue),
    chip("Overdue", state.enquiries.overdue, 'data-overdue="1"', f.overdue, "bad"),
    ...ENQUIRY_STATUSES.map((s) => chip(s, c[s], `data-status="${s}"`, f.status === s && !f.overdue)),
  ].join("");
}
function enquiryRow(e) {
  const open = ["new", "contacted", "interested"].includes(e.status);
  const followup = open
    ? `<input type="date" data-enquiry-followup="${e.id}" value="${dayInput(e.next_followup)}" aria-label="Follow-up date for ${esc(e.name)}">${e.overdue ? pill("Overdue", "bad") : ""}`
    : "—";
  return `<tr><td><strong>${esc(e.name)}</strong><small>${esc(e.contact)}</small>${e.service_interest ? `<small>${esc(e.service_interest)}</small>` : ""}</td><td><select data-enquiry-status="${e.id}" aria-label="Status for ${esc(e.name)}" ${e.status === "booked" ? "disabled" : ""}>${ENQUIRY_STATUSES.map((s) => `<option value="${s}" ${s === e.status ? "selected" : ""} ${s === "booked" && e.status !== "booked" ? "disabled" : ""}>${s}</option>`).join("")}</select></td><td>${esc(SOURCE_LABELS[e.source] || e.source)}</td><td>${followup}</td><td>${esc(e.assigned_to || "—")}</td><td>${esc(stamp(e.last_activity))}</td><td><div class="actions"><button class="secondary" data-action="open-enquiry" data-id="${e.id}">Details</button>${e.thread_id ? `<button class="quiet" data-action="open-thread" data-id="${e.thread_id}">Chat</button>` : ""}</div></td></tr>`;
}
function paintEnquiries() {
  const rows = $("#enquiry-rows");
  if (!rows || state.view !== "enquiries") return;
  $("#enquiry-chips").innerHTML = enquiryChips();
  const items = state.enquiries.items;
  rows.innerHTML = items.map(enquiryRow).join("");
  $("#enquiry-empty").innerHTML = items.length
    ? ""
    : empty("No enquiries here", "New WhatsApp enquiries appear automatically. Add phone and walk-in enquiries with the button above.");
}
async function refreshEnquiries() {
  const clinicId = state.clinic.id;
  const data = await api(`/api/enquiries?${enquiryQuery()}`);
  if (state.clinic.id !== clinicId) return;
  state.enquiries = data;
  paintEnquiries();
}
function renderEnquiries() {
  const f = state.enquiryFilters;
  $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>Everyone who asked, in one list</h3><p>WhatsApp enquiries are added automatically. A status becomes <em>booked</em> only when an appointment exists. Follow-ups here are reminders for your team; nothing is sent to patients.</p></div><button class="primary" data-action="new-enquiry">+ Add enquiry</button></div><div class="chips" id="enquiry-chips">${enquiryChips()}</div><div class="toolbar"><input id="enquiry-search" type="search" placeholder="Search name or phone" aria-label="Search enquiries" value="${esc(f.q)}"><select id="enquiry-source" aria-label="Filter by source"><option value="">All sources</option>${Object.entries(SOURCE_LABELS).map(([k, v]) => `<option value="${k}" ${f.source === k ? "selected" : ""}>${v}</option>`).join("")}</select><select id="enquiry-owner" aria-label="Filter by owner"><option value="">Anyone</option><option value="me" ${f.owner === "me" ? "selected" : ""}>Assigned to me</option><option value="unassigned" ${f.owner === "unassigned" ? "selected" : ""}>Unassigned</option></select></div><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Status</th><th>Source</th><th>Follow-up</th><th>Owner</th><th>Last activity</th><th></th></tr></thead><tbody id="enquiry-rows"></tbody></table></div><div id="enquiry-empty"></div></section>`;
  refreshEnquiries().catch((e) => toast(e.message, true));
}
function enquiryModal(e) {
  const mine = e.assigned_to === state.user.username;
  const events = [...e.events]
    .reverse()
    .map(
      (ev) =>
        `<div class="list-row"><div><strong>${esc(ev.type === "note" ? "Note" : ev.type === "status" ? "Status" : ev.type === "assigned" ? "Assignment" : "Created")}</strong><p>${esc(ev.text)}</p></div><small>${esc(ev.actor)} · ${esc(stamp(ev.t))}</small></div>`,
    )
    .join("");
  modal(
    `${e.name} · ${e.contact}`,
    `<p class="hint">${esc(SOURCE_LABELS[e.source] || e.source)} · ${esc(e.status)}${e.appointment_id ? ` · appointment #${e.appointment_id}` : ""}${e.service_interest ? ` · ${esc(e.service_interest)}` : ""}</p><div class="actions"><button class="secondary" data-action="enquiry-assign" data-id="${e.id}" data-mine="${mine ? "" : "1"}">${mine ? "Unassign me" : "Assign to me"}</button></div><form id="enquiry-note-form" data-id="${e.id}"><label>Add a note<textarea name="text" rows="3" maxlength="1000" required></textarea></label><div class="form-actions"><button class="primary">Save note</button></div></form><h3>Timeline</h3>${events || empty("No activity yet")}`,
  );
}
function newEnquiryModal() {
  modal(
    "Add an enquiry",
    `<form id="enquiry-form"><div class="form-grid"><label>Name<input name="name" required maxlength="120"></label><label>Phone<input name="contact" placeholder="+919…" required></label><label>How did they reach you?<select name="source"><option value="phone">Phone</option><option value="walk_in">Walk-in</option><option value="website">Website</option></select></label><label>Interested in<input name="service_interest" maxlength="120" list="enquiry-services"><datalist id="enquiry-services">${(state.clinic.services || []).map((s) => `<option value="${esc(s)}">`).join("")}</datalist></label><label class="full">Note<textarea name="note" rows="3" maxlength="1000"></textarea></label></div><div class="form-actions"><button class="primary">Save enquiry</button></div><p class="hint">If this phone number already has an enquiry, the details are added to that record instead of creating a duplicate.</p></form>`,
  );
}

const SETUP_PHASES = [
  ["setup", "1. Set up", "Everything here must be done before automation can be switched on."],
  ["test", "2. Test", "The bot only answers while automation is on, so switch it on, then test before announcing the number to patients."],
  ["launch", "3. Agree and launch", "Only the clinic can confirm these. Tick each one once it is true; your name and the date are recorded."],
];
function paintSetupBadge() {
  const r = state.readiness;
  const left = r ? r.progress.total - r.progress.done : 0;
  $("#setup-count").textContent = r && !r.ready && left ? left : "";
  $("#setup-count").title = left ? `${left} step(s) left before this clinic is ready for patients` : "";
}
function setupItem(item, canSign) {
  const tick = `<span class="tick ${item.done ? "done" : ""}" aria-hidden="true">${item.done ? "✓" : "○"}</span>`;
  let action = "";
  if (item.kind === "manual")
    action = `<label class="check-label"><input type="checkbox" data-signoff="${esc(item.key)}" ${item.done ? "checked" : ""} ${canSign ? "" : "disabled"}> Confirmed</label>`;
  else if (!item.done && item.view)
    action = `<button class="secondary" data-view="${esc(item.view)}">Open</button>`;
  const signed = item.signed_by ? `<small>Confirmed by ${esc(item.signed_by)} · ${esc(stamp(item.signed_at))}</small>` : "";
  return `<div class="list-row setup-row"><div class="setup-main">${tick}<div><strong>${esc(item.title)}</strong>${item.required ? "" : ` ${pill("Recommended")}`}<p>${esc(item.detail)}</p>${signed}</div></div><div>${action}</div></div>`;
}
function paintSetup() {
  const r = state.readiness,
    target = $("#setup-body");
  if (!r || !target || state.view !== "setup") return;
  const canAct = state.user.role !== "receptionist";
  const left = r.progress.total - r.progress.done;
  const connected = r.items.find((i) => i.key === "number")?.done && r.items.find((i) => i.key === "inbound_seen")?.done;
  const enableButton = r.enabled
    ? pill("Automation is on", "good")
    : `<button class="primary" data-action="enable-automation" ${canAct && r.can_enable ? "" : "disabled"}>Turn on automation for testing</button>`;
  target.innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>${r.ready ? "Ready for patients" : "Not ready for patients yet"}</h3><p>${r.progress.done} of ${r.progress.total} required steps done${left ? ` · ${left} to go` : ""}</p></div>${enableButton}</div><progress max="${r.progress.total}" value="${r.progress.done}" aria-label="Setup progress"></progress>${!r.enabled && !r.can_enable ? `<p class="hint">Finish the set-up steps below to switch automation on.${canAct ? "" : " An owner or administrator switches it on."}</p>` : ""}${r.ready ? `<p class="hint">Every required step is done. Keep the live acceptance checklist (docs/LIVE_ACCEPTANCE.md) for your records. This checklist is a guide, not a certification.</p>` : ""}</section><section class="panel"><details ${connected ? "" : "open"}><summary><strong>Connect the clinic's WhatsApp number</strong></summary><ol class="steps"><li>In Kapso, connect the clinic-owned number and copy its WhatsApp phone number ID.</li><li>An administrator saves that ID in Clinic settings. Leave automation paused for now.</li><li>Register a <strong>Meta-format</strong> webhook to this address (one webhook per number):<div class="copy-row"><code id="webhook-url">${esc(r.webhook_url)}</code><button class="secondary" data-action="copy-webhook">Copy</button></div></li><li>Send a message from a staff phone to the number. When it shows in Conversations, the connection works.</li></ol><p class="hint">The provider keys live on the server, never in the browser. Details: docs/KAPSO.md.</p></details></section>${SETUP_PHASES.map(([phase, title, hint]) => `<section class="panel"><div class="panel-heading"><div><h3>${esc(title)}</h3><p>${esc(hint)}</p></div></div>${r.items.filter((i) => i.phase === phase).map((i) => setupItem(i, canAct)).join("")}</section>`).join("")}`;
}
function renderSetup() {
  $("#content").innerHTML = `<div id="setup-body">Loading…</div>`;
  api(`/api/clinics/${state.clinic.id}/readiness`)
    .then((data) => {
      state.readiness = data;
      paintSetupBadge();
      paintSetup();
    })
    .catch((e) => toast(e.message, true));
}

const FOLLOWUP_OUTCOMES = [
  ["reached", "Spoke to them"],
  ["interested", "Spoke to them — interested"],
  ["no_answer", "No answer"],
  ["snooze", "Not now — remind me later"],
  ["lost", "Not going ahead"],
];
const REMIND_OPTIONS = [
  ["", "Automatic"],
  ["1", "Tomorrow"],
  ["2", "In 2 days"],
  ["3", "In 3 days"],
  ["7", "In a week"],
  ["14", "In 2 weeks"],
  ["30", "In a month"],
];
function followupRow(e) {
  return `<tr><td><strong>${esc(e.name)}</strong><small>${esc(e.contact)}</small>${e.service_interest ? `<small>${esc(e.service_interest)}</small>` : ""}</td><td>${e.next_followup ? esc(stamp(e.next_followup)) : "No date set"}${e.no_answers ? `<small>${e.no_answers} unanswered call${e.no_answers > 1 ? "s" : ""}</small>` : ""}</td><td>${esc(e.status)}<small>${esc(SOURCE_LABELS[e.source] || e.source)}${e.assigned_to ? ` · ${esc(e.assigned_to)}` : ""}</small></td><td><div class="actions"><button class="primary" data-action="log-followup" data-id="${e.id}">Log follow-up</button>${e.thread_id ? `<button class="quiet" data-action="open-thread" data-id="${e.thread_id}">Chat</button>` : ""}<button class="quiet" data-action="open-enquiry-from-queue" data-id="${e.id}">Details</button></div></td></tr>`;
}
function followupSection(title, hint, rows, tone = "") {
  return `<section class="panel"><div class="panel-heading"><div><h3>${esc(title)} ${rows.length ? pill(String(rows.length), tone) : ""}</h3><p>${esc(hint)}</p></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${rows.map(followupRow).join("")}</tbody></table></div>` : empty("Nothing here")}</section>`;
}
function paintFollowups() {
  const q = state.followups,
    target = $("#followup-sections");
  if (!q || !target || state.view !== "followups") return;
  const all = [...q.overdue, ...q.today, ...q.unscheduled];
  target.innerHTML =
    followupSection("Overdue", "Call these first. Oldest are at the top.", q.overdue, "bad") +
    followupSection("Due today", "Still to come before the clinic closes.", q.today, "warn") +
    followupSection("No follow-up date", "Open enquiries that nobody has scheduled. Log a follow-up to set one, or mark them as not going ahead.", q.unscheduled) +
    `<p class="hint">${q.counts.upcoming} more follow-up(s) are scheduled for later. Booked and lost enquiries leave this list automatically, and so does anyone who replies STOP on WhatsApp.${all.length ? "" : " Nothing needs a call right now."}</p>`;
  state.followupItems = all;
}
function renderFollowups() {
  const canEdit = state.user.role !== "receptionist";
  const q = state.followups,
    hours = q?.followup_hours ?? 4;
  const options = [...new Set([1, 2, 4, 8, 24, 48, 72, hours])].sort((a, b) => a - b);
  $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>People to call back</h3><p>Reminders for your team only. Nothing is sent to patients from this screen.</p></div>${canEdit ? `<label class="inline-field">First reminder after<select id="followup-hours" aria-label="Hours before the first follow-up reminder">${options.map((h) => `<option value="${h}" ${h === hours ? "selected" : ""}>${h} hour${h > 1 ? "s" : ""}</option>`).join("")}</select></label>` : ""}</div><p class="hint">New enquiries are due this many hours after they arrive, moved to the next time the clinic is open (reception hours, closed days and leave).</p></section><div id="followup-sections">Loading…</div>`;
  api(`/api/followups?clinic_id=${state.clinic.id}`)
    .then((data) => {
      state.followups = data;
      paintFollowups();
    })
    .catch((e) => toast(e.message, true));
}
function followupModal(e) {
  modal(
    `Follow up with ${e.name}`,
    `<form id="followup-form" data-id="${e.id}"><p class="hint">${esc(e.contact)}${e.service_interest ? ` · ${esc(e.service_interest)}` : ""}${e.no_answers ? ` · ${e.no_answers} unanswered call(s) so far` : ""}</p><div class="form-grid"><label>What happened?<select name="outcome" id="followup-outcome">${FOLLOWUP_OUTCOMES.map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label><label>Remind me again<select name="next_in_days" id="followup-next">${REMIND_OPTIONS.map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label><label class="full">Note<textarea name="note" rows="3" maxlength="1000"></textarea></label></div><div class="form-actions"><button class="primary">Save</button></div><p class="hint" id="followup-help"></p></form>`,
  );
  updateFollowupHelp();
}
function updateFollowupHelp() {
  const out = $("#followup-outcome")?.value;
  const help = {
    reached: "Leave the reminder on Automatic to finish with no further reminder, or pick a day to call again.",
    interested: "Marks them as interested. Pick a day to call again, or leave Automatic for no further reminder.",
    no_answer: `Automatic tries again after ${state.followups?.followup_hours ?? 4} hour(s) of clinic time.`,
    snooze: "Choose when to be reminded; Automatic is not available for this option.",
    lost: "Closes the enquiry. If they message again it reopens.",
  }[out];
  if ($("#followup-help")) $("#followup-help").textContent = help || "";
}

const PERIOD_OPTIONS = [
  ["today", "Today"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
  ["month", "This month"],
  ["all", "All time"],
  ["custom", "Custom range"],
];
const rate = (v) => (v === null || v === undefined ? "—" : `${v}%`);
function reportQuery() {
  const r = state.reportPeriod;
  const p = new URLSearchParams({ clinic_id: String(state.clinic.id), period: r.period });
  if (r.period === "custom") {
    p.set("start", r.start);
    p.set("end", r.end);
  }
  return p.toString();
}
function reportTable(headers, rows) {
  if (!rows.length) return empty("Nothing recorded in this period");
  return `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<td><strong>${esc(c)}</strong></td>` : `<td>${esc(c)}</td>`)).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function paintReport() {
  const d = state.performance,
    target = $("#report-body");
  if (!d || !target || state.view !== "reports") return;
  const e = d.enquiries,
    a = d.attendance,
    b = d.bookings,
    m = d.messaging;
  const cards = [
    ["Enquiries", e.total, `${e.open} still open · ${e.lost} lost`],
    ["Enquiry → booking", rate(e.conversion_rate), `${e.booked} of ${e.total} have a booking`],
    ["Bookings made", b.made, `${b.whatsapp} WhatsApp · ${b.staff} by staff`],
    ["Attendance", rate(a.attendance_rate), `${a.attended} attended · ${a.no_shows} no-shows`],
    ["No-show rate", rate(a.no_show_rate), a.unrecorded ? `${a.unrecorded} past visit(s) not yet marked` : "Recorded outcomes only"],
    ["Messaging problems", m.failed + m.uncertain, `${m.failed} failed · ${m.uncertain} uncertain · ${m.needs_attention} chats need attention`],
  ];
  const sourceName = (s) => SOURCE_LABELS[s] || s;
  const money0 = (v) => (v ? money(v) : "—");
  const cmp = d.comparison;
  const canEdit = state.user.role !== "receptionist";
  const bl = d.baseline || {};
  const labels = { enquiries_per_week: "Enquiries per week", bookings_per_week: "Bookings per week", no_show_percent: "No-show rate (%)" };
  const baselinePanel = `<section class="panel"><div class="panel-heading"><div><h3>Before and during the pilot</h3><p>Enter the clinic’s typical weekly numbers from before Jyutrix, then compare any range of 7 days or more.</p></div></div>${
    cmp && Object.keys(cmp).length
      ? reportTable(["Measure", "Before", "Now", "Change"], Object.entries(cmp).map(([k, v]) => [labels[k], v.baseline, v.current, `${v.change > 0 ? "+" : ""}${v.change}`]))
      : `<p class="hint">${d.baseline ? "Choose a range of at least 7 days to see the comparison." : "No baseline saved yet."}</p>`
  }${canEdit ? `<form id="baseline-form"><div class="form-grid"><label>Enquiries per week before<input name="enquiries_per_week" type="number" min="0" max="100000" value="${esc(bl.enquiries_per_week ?? "")}"></label><label>Bookings per week before<input name="bookings_per_week" type="number" min="0" max="100000" value="${esc(bl.bookings_per_week ?? "")}"></label><label>No-show rate before (%)<input name="no_show_percent" type="number" min="0" max="100" value="${esc(bl.no_show_percent ?? "")}"></label></div><div class="form-actions"><button class="secondary">Save baseline</button></div></form>` : ""}</section>`;
  target.innerHTML = `<div class="metrics report-metrics">${cards.map(([l, v, s]) => `<div class="metric"><p>${esc(l)}</p><strong>${esc(v)}</strong><small>${esc(s)}</small></div>`).join("")}</div><div class="two-col"><section class="panel"><div class="panel-heading"><div><h3>Where enquiries come from</h3><p>${esc(d.period.label)} · ${e.overdue_followups} follow-up(s) overdue now</p></div></div>${reportTable(["Source", "Enquiries", "Booked", "Conversion"], e.by_source.map((s) => [sourceName(s.source), s.enquiries, s.booked, rate(s.conversion_rate)]))}${b.direct_without_enquiry ? `<p class="hint">${b.direct_without_enquiry} booking(s) were made by staff for people with no earlier enquiry. They are counted as bookings, not as converted enquiries.</p>` : ""}</section>${baselinePanel}</div><section class="panel"><div class="panel-heading"><div><h3>By doctor</h3><p>Visits scheduled in the period</p></div></div>${reportTable(["Doctor", "Booked", "Attended", "No-shows", "Cancelled", "Payments recorded"], d.by_doctor.map((r) => [r.name, r.booked, r.attended, r.no_shows, r.cancelled, money0(r.recorded_payments)]))}</section><section class="panel"><div class="panel-heading"><div><h3>By service</h3><p>Visits scheduled in the period</p></div></div>${reportTable(["Service", "Booked", "Attended", "No-shows", "Cancelled", "Payments recorded"], d.by_service.map((r) => [r.name, r.booked, r.attended, r.no_shows, r.cancelled, money0(r.recorded_payments)]))}</section>${d.series ? `<section class="panel"><details><summary><strong>Day by day</strong></summary>${reportTable(["Date", "Enquiries", "Bookings made"], [...d.series].reverse().map((r) => [r.date, r.enquiries, r.bookings]))}</details></section>` : ""}<p class="hint">${esc(d.definition)}</p>`;
}
async function refreshReport() {
  const clinicId = state.clinic.id,
    r = state.reportPeriod;
  if (r.period === "custom" && (!r.start || !r.end)) return;
  const data = await api(`/api/reports/performance?${reportQuery()}`);
  if (state.clinic.id !== clinicId) return;
  state.performance = data;
  paintReport();
}
function renderReports() {
  const r = state.reportPeriod;
  $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>How the clinic is doing</h3><p>Operational counts from live records. Demo data is never included.</p></div><button class="secondary" data-action="export-report">Export CSV</button></div><div class="toolbar"><select id="report-period" aria-label="Report period">${PERIOD_OPTIONS.map(([k, v]) => `<option value="${k}" ${r.period === k ? "selected" : ""}>${v}</option>`).join("")}</select><input id="report-start" type="date" aria-label="Start date" value="${esc(r.start)}" ${r.period === "custom" ? "" : "hidden"}><input id="report-end" type="date" aria-label="End date" value="${esc(r.end)}" ${r.period === "custom" ? "" : "hidden"}></div></section><div id="report-body">Loading report…</div>`;
  refreshReport().catch((e) => toast(e.message, true));
}
async function exportReport() {
  const token = await getClerkToken();
  const response = await fetch(`/api/reports/export?${reportQuery()}`, {
    credentials: "same-origin",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    let detail = "Export failed";
    try {
      detail = (await response.json()).detail || detail;
    } catch {}
    throw Error(detail);
  }
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement("a");
  link.href = url;
  link.download = `jyutrix-report-${state.reportPeriod.period}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderDemo() {
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-heading"><div><h3>Try a patient conversation</h3><p>Same booking engine, separate demo records. No WhatsApp messages are sent.</p></div>${pill("Demo only", "warn")}</div><form id="demo-form"><div class="form-grid"><label>Patient name<input name="name" value="Demo patient" required></label><label>Demo contact<input name="contact" value="919999000001" required></label></div><div class="demo-chat" id="demo-chat">Send BOOK → choose 1 → send YES. No booking is created until confirmation.</div><div class="demo-quick">${["Hello", "BOOK", "1", "YES", "FEES", "RESCHEDULE", "CANCEL", "STAFF", "STOP", "START"].map((t) => `<button type="button" class="secondary" data-action="demo-quick" data-text="${t}">${t}</button>`).join("")}</div><div class="form-actions"><input name="text" placeholder="Type a patient message…" required maxlength="4000" aria-label="Demo patient message"><button class="primary">Send</button></div></form><p class="hint">The prototype recognizes selected Telugu/Hindi phrases; replies currently use English. Full translated conversation quality requires separate acceptance testing.</p></section>`;
}
function modal(title, html) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal").showModal();
}
async function newAppointment(moveId = null) {
  const a = state.appts.find((x) => x.id === moveId);
  const clinicId = state.clinic.id;
  const [doctors, services] = await Promise.all([
    api(`/api/doctors?clinic_id=${clinicId}`),
    api(`/api/services?clinic_id=${clinicId}`),
  ]);
  state.doctors = doctors;
  state.services = services;
  const activeDoctors = doctors.filter((d) => d.active);
  const activeServices = services.filter((s) => s.active);
  if (!activeDoctors.length || !activeServices.length) {
    toast("Add an active doctor and service before booking", true);
    return;
  }
  const doctorId = a?.doctor_id || activeDoctors[0].id;
  const serviceId = a?.service_id || activeServices[0].id;
  const slots = await api(`/api/availability?clinic_id=${clinicId}&doctor_id=${doctorId}&service_id=${serviceId}`);
  modal(
    moveId ? "Reschedule appointment" : "Book an appointment",
    `<form id="appointment-form" data-move="${moveId || ""}"><div class="form-grid"><label>Patient name<input name="name" value="${esc(a?.name || "")}" required></label><label>Patient phone<input name="contact" value="${esc(a?.contact || "")}" placeholder="+919…" required></label><label>Doctor<select name="doctor_id" id="booking-doctor">${activeDoctors.map((d) => `<option value="${d.id}" ${d.id === doctorId ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label><label>Service<select name="service_id" id="booking-service">${activeServices.map((s) => `<option value="${s.id}" ${s.id === serviceId ? "selected" : ""}>${esc(s.name)} · ${s.duration} min · ${money(s.fee)}</option>`).join("")}</select></label><label class="full">Find a date<input id="booking-day" type="date"></label><label class="full">Available slot<select name="scheduled_at" id="slot-select" required>${slots.map((s) => `<option value="${esc(s.iso)}">${esc(s.label)}</option>`).join("")}</select></label><label class="full check-label"><input name="consent" type="checkbox" ${a?.consent ? "checked" : ""}>Patient agreed to appointment messages on WhatsApp</label></div><div class="form-actions"><button class="primary">${moveId ? "Confirm new time" : "Confirm booking"}</button></div><p class="hint">Availability is checked again for this doctor and service when you confirm.</p></form>`,
  );
}

async function refreshBookingSlots() {
  const form = $("#appointment-form");
  if (!form) return;
  const date = $("#booking-day").value;
  const params = new URLSearchParams({
    clinic_id: String(state.clinic.id),
    doctor_id: $("#booking-doctor").value,
    service_id: $("#booking-service").value,
  });
  if (date) params.set("day", date);
  const slots = await api(`/api/availability?${params}`);
  $("#slot-select").innerHTML = slots
    .map((slot) => `<option value="${esc(slot.iso)}">${esc(slot.label)}</option>`)
    .join("");
  if (!slots.length) toast("No slots available for this doctor, service and date");
}
function filterAppointments() {
  const q = $("#appointment-search").value.toLowerCase(),
    status = $("#appointment-filter").value;
  document
    .querySelectorAll("#appointment-rows tr")
    .forEach(
      (r) =>
        (r.hidden =
          !r.dataset.search.includes(q) ||
          (status && r.dataset.status !== status)),
    );
}
function exportCSV() {
  const safe = (v) => {
    let s = String(v ?? "");
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const rows = [
    ["id", "name", "contact", "date", "status", "source", "paid_amount"],
    ...state.appts.map((a) => [
      a.id,
      a.name,
      a.contact,
      a.label,
      a.status,
      a.source,
      a.paid_amount,
    ]),
  ];
  const blob = new Blob(
    ["\ufeff" + rows.map((r) => r.map(safe).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = "clinic-appointments.csv";
  a.click();
  URL.revokeObjectURL(url);
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.dataset.view) {
      state.view = button.dataset.view;
      renderView();
      return;
    }
    if (button.id === "waitlist-refresh") {
      renderWaitlist();
      return;
    }
    const action = button.dataset.action,
      id = Number(button.dataset.id);
    if (!action) return;
    if (action === "cancel-waitlist") {
      if (!confirm("Remove this patient from the cancellation waitlist?")) return;
      await post(`/api/waitlist/${id}/cancel`);
      renderWaitlist();
      toast("Waitlist entry removed");
    } else if (action === "delete-lead") {
      if (!confirm("Delete this demo request and its contact details? This cannot be undone.")) return;
      await api(`/api/leads/${id}`, { method: "DELETE" });
      renderLeads();
      toast("Enquiry deleted");
    } else if (action === "open-thread") {
      state.selectedThread = id;
      if (state.view !== "inbox") {
        state.view = "inbox";
        renderView();
      } else {
        renderThreadList();
        await renderMessages();
      }
    } else if (action === "new-doctor") {
      modal("Add doctor", doctorFormHtml());
    } else if (action === "edit-doctor") {
      const doctor = state.doctors.find((item) => item.id === id);
      if (doctor) modal("Edit doctor schedule", doctorFormHtml(doctor));
    } else if (action === "new-service") {
      modal("Add service", serviceFormHtml());
    } else if (action === "edit-service") {
      const service = state.services.find((item) => item.id === id);
      if (service) modal("Edit service", serviceFormHtml(service));
    } else if (action === "new-clinic")
      modal(
        "Add a clinic",
        `<form id="new-clinic-form">${clinicFields()}<div class="form-actions"><button class="primary">Create clinic</button></div></form>`,
      );
    else if (action === "new-appointment") await newAppointment();
    else if (action === "reschedule") await newAppointment(id);
    else if (["complete", "no-show", "cancel"].includes(action)) {
      if (
        !confirm(
          `Mark appointment #${id} ${action === "complete" ? "completed" : action === "no-show" ? "no-show" : "cancelled"}?`,
        )
      )
        return;
      await api(`/api/appointments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status:
            action === "complete"
              ? "completed"
              : action === "no-show"
                ? "no_show"
                : "cancelled",
        }),
      });
      await load();
      toast("Appointment updated");
    } else if (action === "payment") {
      modal(
        "Record payment",
        `<form id="payment-form" data-id="${id}"><label>Amount paid (₹)<input name="amount" type="number" min="0" max="10000000" required></label><div class="form-actions"><button class="primary">Save recorded payment</button></div><p class="hint">This records a payment reported by staff; it does not collect money.</p></form>`,
      );
    } else if (action === "takeover" || action === "resume") {
      await post(`/api/threads/${id}/${action}`);
      await load();
      toast(action === "resume" ? "Automation resumed" : "You are in control");
    } else if (action === "erase") {
      if (
        !confirm(
          "Delete this patient’s conversation data and anonymize appointment records? This cannot be undone.",
        )
      )
        return;
      await api(`/api/threads/${id}/patient`, { method: "DELETE" });
      state.selectedThread = null;
      await load();
      toast("Patient data deleted");
    } else if (action === "retry") {
      const j = state.jobs.find((j) => j.id === id);
      if (
        !confirm(
          j.status === "uncertain"
            ? "Have you checked Kapso logs and confirmed this message was NOT sent? Only continue after that check."
            : "Have you fixed the reported issue and checked this retry will not duplicate a delivered message?",
        )
      )
        return;
      await post(`/api/jobs/${id}/retry`, { reviewed_provider_logs: true });
      await load();
      toast("Retry queued");
    } else if (action === "add-faq")
      $("#faq-rows").insertAdjacentHTML("beforeend", faqRow());
    else if (action === "remove-faq") button.closest(".faq-row").remove();
    else if (action === "new-user")
      modal(
        "Add clinic staff",
        `<form id="user-form"><div class="form-grid"><label>Username<input name="username" required minlength="3"></label><label>Work email (for Clerk sign-in)<input name="email" type="email" placeholder="reception@clinic.com"></label>${authConfig.clerk_enabled ? "" : `<label>Temporary password<input name="password" type="password" required minlength="16" autocomplete="new-password"></label>`}<label>Role<select name="role"><option value="receptionist">Receptionist</option><option value="owner">Owner</option></select></label></div><div class="form-actions"><button class="primary">Create account</button></div><p class="hint">Account is restricted to ${esc(state.clinic.name)}.${authConfig.clerk_enabled ? " When they sign up in Clerk with this email, they automatically join your clinic." : " Share credentials securely; staff can change their password after login."}</p></form>`,
      );
    else if (action === "disable-user") {
      if (!confirm("Disable this staff account and revoke its sessions?"))
        return;
      await post(`/api/users/${id}/disable`);
      renderSettings();
    } else if (action === "demo-quick") {
      $("#demo-form [name=text]").value = button.dataset.text;
      $("#demo-form").requestSubmit();
    } else if (action === "new-enquiry") newEnquiryModal();
    else if (action === "open-enquiry") {
      const found = state.enquiries.items.find((item) => item.id === id);
      if (found) enquiryModal(found);
    } else if (action === "enquiry-chip") {
      const f = state.enquiryFilters;
      f.overdue = button.dataset.overdue === "1";
      f.status = f.overdue ? "" : button.dataset.status || "";
      await refreshEnquiries();
    } else if (action === "enquiry-assign") {
      const updated = await api(`/api/enquiries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          assigned_to: button.dataset.mine ? state.user.username : null,
        }),
      });
      await refreshEnquiries();
      enquiryModal(updated);
    } else if (action === "log-followup" || action === "open-enquiry-from-queue") {
      const found = (state.followupItems || []).find((item) => item.id === id);
      if (!found) return;
      if (action === "log-followup") followupModal(found);
      else enquiryModal(found);
    } else if (action === "enable-automation") {
      if (!confirm("Turn on automation for this clinic? The bot will start answering messages sent to the clinic's WhatsApp number.")) return;
      state.readiness = await post(`/api/clinics/${state.clinic.id}/enable-automation`);
      state.clinic.enabled = true;
      paintSetupBadge();
      paintSetup();
      await load(false);
      toast("Automation is on. Now run the tests below.");
    } else if (action === "copy-webhook") {
      try {
        await navigator.clipboard.writeText($("#webhook-url").textContent);
        toast("Webhook address copied");
      } catch {
        toast("Could not copy. Select the address and copy it manually.", true);
      }
    } else if (action === "export-report") await exportReport();
    else if (action === "export") exportCSV();
  } catch (e) {
    toast(e.message, true);
  }
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  event.preventDefault();
  const button = form.querySelector("[type=submit],button:not([type=button])");
  if (button) button.disabled = true;
  try {
    if (form.id === "login-form") {
      const d = Object.fromEntries(new FormData(form));
      state.user = await post("/api/auth/login", d);
      await launch();
      $("#login-error").textContent = "";
    } else if (form.id === "register-form") {
      const d = Object.fromEntries(new FormData(form));
      state.user = await post("/api/auth/register", {
        email: d.email,
        username: d.email,
        password: d.password,
      });
      await launch();
      $("#login-error").textContent = "";
    } else if (form.id === "onboarding-clinic-form") {
      const d = new FormData(form);
      const created = await post("/api/onboarding/clinic", {
        name: d.get("name"),
        doctor: d.get("doctor"),
        phone: d.get("phone"),
        address: d.get("address"),
        timezone: d.get("timezone"),
        fee: Number(d.get("fee")),
        duration: Number(d.get("duration")),
        open: d.get("open"),
        close: d.get("close"),
        services: String(d.get("services") || "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      state.clinic = created;
      state.user.clinic_id = created.id;
      state.view = "setup";
      await launch();
      toast("Clinic workspace created — complete Go-live setup next.");
    } else if (form.id === "settings-form" || form.id === "new-clinic-form") {
      const data = readClinic(form);
      const c = await api(
        form.id === "settings-form"
          ? `/api/clinics/${state.clinic.id}`
          : "/api/clinics",
        {
          method: form.id === "settings-form" ? "PUT" : "POST",
          body: JSON.stringify(data),
        },
      );
      state.clinic = c;
      if ($("#modal").open) $("#modal").close();
      await launch();
      toast("Clinic saved");
    } else if (form.id === "growth-doctor-form") {
      const id = Number(form.dataset.id);
      await api(
        id
          ? `/api/doctors/${id}`
          : `/api/clinics/${state.clinic.id}/doctors`,
        {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(readDoctorForm(form)),
        },
      );
      $("#modal").close();
      await renderGrowthCatalog();
      toast("Doctor schedule saved");
    } else if (form.id === "growth-service-form") {
      const id = Number(form.dataset.id);
      const data = {
        ...Object.fromEntries(new FormData(form)),
        duration: Number(new FormData(form).get("duration")),
        fee: Number(new FormData(form).get("fee")),
        active: new FormData(form).has("active"),
      };
      await api(
        id
          ? `/api/services/${id}`
          : `/api/clinics/${state.clinic.id}/services`,
        {
          method: id ? "PUT" : "POST",
          body: JSON.stringify(data),
        },
      );
      $("#modal").close();
      await renderGrowthCatalog();
      toast("Service saved");
    } else if (form.id === "appointment-form") {
      const d = new FormData(form),
        id = Number(form.dataset.move);
      if (id)
        await api(`/api/appointments/${id}`, {
          method: "PATCH",
          body: JSON.stringify({
            scheduled_at: d.get("scheduled_at"),
            doctor_id: Number(d.get("doctor_id")),
            service_id: Number(d.get("service_id")),
          }),
        });
      else
        await post("/api/appointments", {
          clinic_id: state.clinic.id,
          name: d.get("name"),
          contact: d.get("contact"),
          scheduled_at: d.get("scheduled_at"),
          consent: d.has("consent"),
          doctor_id: Number(d.get("doctor_id")),
          service_id: Number(d.get("service_id")),
          request_key: crypto.randomUUID(),
        });
      $("#modal").close();
      await load();
      toast("Appointment confirmed");
    } else if (form.id === "reply-form") {
      await post(`/api/threads/${state.selectedThread}/reply`, {
        text: $("#reply-text").value,
      });
      $("#reply-text").value = "";
      await load();
      toast("Reply queued");
    } else if (form.id === "demo-form") {
      const d = Object.fromEntries(new FormData(form)),
        r = await post("/api/demo/message", {
          ...d,
          clinic_id: state.clinic.id,
        });
      $("#demo-chat").textContent =
        `You: ${d.text}\n\nReception: ${r.reply || "Staff has control; automated replies are paused."}\n\nConversation mode: ${r.mode}`;
      form.querySelector("[name=text]").value = "";
    } else if (form.id === "user-form") {
      await post("/api/users", {
        ...Object.fromEntries(new FormData(form)),
        clinic_id: state.clinic.id,
      });
      $("#modal").close();
      renderSettings();
      toast("Staff account created");
    } else if (form.id === "password-form") {
      await post("/api/auth/password", Object.fromEntries(new FormData(form)));
      showLogin();
      toast("Password changed. Sign in again.");
    } else if (form.id === "followup-form") {
      const d = new FormData(form);
      const body = { outcome: d.get("outcome"), note: d.get("note") };
      if (d.get("next_in_days")) body.next_in_days = Number(d.get("next_in_days"));
      if (body.outcome === "snooze" && !body.next_in_days) {
        toast("Choose when to be reminded", true);
        return;
      }
      await post(`/api/enquiries/${form.dataset.id}/followup`, body);
      $("#modal").close();
      await load();
      toast("Follow-up saved");
    } else if (form.id === "baseline-form") {
      const body = {};
      for (const [k, v] of new FormData(form)) body[k] = v === "" ? null : Number(v);
      await api(`/api/clinics/${state.clinic.id}/baseline`, { method: "PUT", body: JSON.stringify(body) });
      await refreshReport();
      toast("Baseline saved");
    } else if (form.id === "enquiry-form") {
      const d = Object.fromEntries(new FormData(form));
      const saved = await post("/api/enquiries", { ...d, clinic_id: state.clinic.id });
      $("#modal").close();
      await refreshEnquiries();
      toast(saved.created ? "Enquiry added" : "Added to the existing enquiry for this number");
    } else if (form.id === "enquiry-note-form") {
      const updated = await post(`/api/enquiries/${form.dataset.id}/notes`, {
        text: new FormData(form).get("text"),
      });
      enquiryModal(updated);
      await refreshEnquiries();
      toast("Note saved");
    } else if (form.id === "payment-form") {
      await api(`/api/appointments/${form.dataset.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          paid_amount: Number(new FormData(form).get("amount")),
        }),
      });
      $("#modal").close();
      await load();
      toast("Payment recorded");
    }
  } catch (e) {
    if (form.id === "login-form" || form.id === "register-form") $("#login-error").textContent = e.message;
    else toast(e.message, true);
  } finally {
    if (button) button.disabled = false;
  }
});
let enquirySearchTimer;
document.addEventListener("input", (event) => {
  if (["appointment-search", "appointment-filter"].includes(event.target.id))
    filterAppointments();
  if (event.target.id === "enquiry-search") {
    state.enquiryFilters.q = event.target.value;
    clearTimeout(enquirySearchTimer);
    enquirySearchTimer = setTimeout(
      () => refreshEnquiries().catch((e) => toast(e.message, true)),
      300,
    );
  }
});
document.addEventListener("change", async (event) => {
  try {
    if (event.target.id === "clinic-select") {
      state.clinic = state.clinics.find(
        (c) => c.id === Number(event.target.value),
      );
      state.selectedThread = null;
      await load();
    }
    if (["booking-day", "booking-doctor", "booking-service"].includes(event.target.id)) {
      await refreshBookingSlots();
    }
    if (event.target.id === "appointment-filter") filterAppointments();
    if (event.target.matches("[data-signoff]")) {
      const box = event.target;
      try {
        state.readiness = await api(`/api/clinics/${state.clinic.id}/onboarding/${box.dataset.signoff}`, {
          method: "PUT",
          body: JSON.stringify({ done: box.checked }),
        });
        paintSetupBadge();
      } finally {
        paintSetup();
      }
    }
    if (event.target.id === "followup-outcome") updateFollowupHelp();
    if (event.target.id === "followup-hours") {
      await api(`/api/clinics/${state.clinic.id}/followup-settings`, {
        method: "PUT",
        body: JSON.stringify({ hours: Number(event.target.value) }),
      });
      toast("Saved. Applies to new enquiries.");
      await load();
    }
    if (["report-period", "report-start", "report-end"].includes(event.target.id)) {
      const r = state.reportPeriod;
      if (event.target.id === "report-period") r.period = event.target.value;
      if (event.target.id === "report-start") r.start = event.target.value;
      if (event.target.id === "report-end") r.end = event.target.value;
      $("#report-start").hidden = $("#report-end").hidden = r.period !== "custom";
      await refreshReport();
    }
    if (["enquiry-source", "enquiry-owner"].includes(event.target.id)) {
      state.enquiryFilters[event.target.id === "enquiry-source" ? "source" : "owner"] =
        event.target.value;
      await refreshEnquiries();
    }
    if (event.target.matches("[data-enquiry-status], [data-enquiry-followup]")) {
      const isStatus = event.target.matches("[data-enquiry-status]");
      const id = event.target.dataset.enquiryStatus || event.target.dataset.enquiryFollowup;
      const body = isStatus
        ? { status: event.target.value }
        : {
            next_followup: event.target.value
              ? Math.floor(new Date(`${event.target.value}T09:00:00`).getTime() / 1000)
              : null,
          };
      try {
        await api(`/api/enquiries/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast(isStatus ? "Status updated" : "Follow-up date saved");
      } finally {
        await refreshEnquiries();
      }
    }
    if (event.target.matches("[data-lead-id]")) {
      await api(`/api/leads/${event.target.dataset.leadId}`, {
        method: "PATCH",
        body: JSON.stringify({ status: event.target.value }),
      });
      toast("Enquiry stage updated");
    }
  } catch (e) {
    toast(e.message, true);
  }
});
document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-auth-tab]");
  if (!tab) return;
  const isReg = tab.dataset.authTab === "register";
  $("#login-form").hidden = isReg;
  $("#register-form").hidden = !isReg;
  $("#tab-signin").className = isReg ? "quiet" : "secondary";
  $("#tab-register").className = isReg ? "secondary" : "quiet";
  $("#login-error").textContent = "";
});
$("#close-modal").addEventListener("click", () => $("#modal").close());
$("#logout").addEventListener("click", async () => {
  try {
    if (clerkInstance && clerkInstance.user) {
      await clerkInstance.signOut();
    } else {
      await post("/api/auth/logout");
    }
    showLogin();
  } catch (e) {
    toast(e.message, true);
  }
});
$("#refresh").addEventListener("click", () =>
  load().catch((e) => toast(e.message, true)),
);
(async () => {
  try {
    const [h, cfg] = await Promise.all([
      fetch("/health").then((r) => r.json()),
      fetch("/api/auth/config").then((r) => r.json()).catch(() => ({ clerk_enabled: false })),
    ]);
    authConfig = cfg;
    if (h.mode === "demo" && !cfg.clerk_enabled) {
      $("#demo-login").hidden = false;
      $("#login-form [name=username]").value = "admin";
    }
    if (cfg.clerk_enabled && cfg.clerk_publishable_key) {
      await initClerk(cfg.clerk_publishable_key);
      if (clerkInstance && clerkInstance.user) {
        state.user = await api("/api/auth/me");
        await launch();
        return;
      }
      showLogin();
      return;
    }
    state.user = await api("/api/auth/me");
    await launch();
  } catch {
    showLogin();
  }
})();
