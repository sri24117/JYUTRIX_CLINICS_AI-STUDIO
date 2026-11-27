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
  timelineDay: "",
  timelineDoctor: null,
  reviews: null,
  presets: [],
  copilotResult: null,
  voice: null,
  queue: null,
  queueDate: "",
  recalls: null,
  recallCampaigns: [],
  recallKind: "six_month_checkup",
  recallDays: "",
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
  queue: "Token queue",
  inbox: "Conversations",
  delivery: "Message delivery",
  settings: "Clinic settings",
  demo: "Try the demo",
  leads: "Sales enquiries",
  waitlist: "Cancellation waitlist",
  enquiries: "Patient enquiries",
  recalls: "Patient recalls",
  reports: "Performance",
  reviews: "Reviews & feedback",
  voice: "Voice AI & minutes",
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
    api(`/api/voice/calls?clinic_id=${id}`),
  ]);
  if (state.clinic.id !== id) return;
  [state.threads, state.appts, state.jobs, state.report, state.status, state.entitlements, state.followups, state.voice] =
    results;
  // Readiness changes only when someone acts on it, so it is not part of the 15-second refresh.
  if (render || state.view === "setup" || !state.readiness || state.readiness.clinic_id !== id) {
    state.readiness = await api(`/api/clinics/${id}/readiness`);
    paintSetupBadge();
  }
  const dueNow = state.followups.counts.overdue + state.followups.counts.today;
  $("#followup-count").textContent = dueNow || "";
  $("#followup-count").title = dueNow ? `${state.followups.counts.overdue} overdue · ${state.followups.counts.today} due today` : "";
  const voiceBadge = $("#voice-badge");
  if (voiceBadge && state.voice?.usage) {
    const vu = state.voice.usage;
    voiceBadge.textContent =
      vu.alert_level === "exceeded"
        ? "LIMIT"
        : vu.alert_level === "warning"
          ? `${vu.usage_percent}%`
          : "";
    voiceBadge.title = vu.alert_message || "";
  }
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
    } else if (state.view === "voice" && !render && $("#voice-body")) {
      paintVoice();
    } else if (state.view === "queue" && !render && $("#queue-body")) {
      await refreshQueue();
    } else if (state.view === "recalls" && !render && $("#recalls-body")) {
      await refreshRecalls();
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
    $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>Welcome to Jyutrix</h3><p>Enter your clinic’s reception details to create your workspace and open the Go-live setup checklist.</p></div></div><form id="onboarding-clinic-form"><div class="form-grid"><label>Clinic specialty<select name="vertical"><option value="dental" selected>Dental Clinic (7 services + FAQs)</option><option value="dermatology">Dermatology &amp; Skin Clinic (6 services + FAQs)</option><option value="physiotherapy">Physiotherapy &amp; Rehab (5 services + FAQs)</option><option value="general">General Physician &amp; Polyclinic (5 services + FAQs)</option><option value="eye_ent">Eye &amp; ENT Clinic (5 services + FAQs)</option></select></label><label>Clinic name<input name="name" placeholder="Smile Care Dental" required minlength="2" maxlength="120"></label><label>Primary doctor<input name="doctor" placeholder="Dr. Rao" required minlength="2" maxlength="120"></label><label>Clinic phone / WhatsApp<input name="phone" placeholder="+919876543210" required></label><label>Consultation fee (₹)<input name="fee" type="number" min="0" value="500" required></label><label>Timezone<select name="timezone"><option value="Asia/Kolkata" selected>Asia/Kolkata</option><option value="UTC">UTC</option></select></label><label class="full">Clinic address<input name="address" placeholder="Street, area, city" required minlength="4" maxlength="600"></label><label>Appointment slot duration (minutes)<input name="duration" type="number" min="5" max="120" value="30" required></label><label>Reception opens<input name="open" type="time" value="09:00" required></label><label>Reception closes<input name="close" type="time" value="19:00" required></label><label class="full">Google Review link (optional)<input name="google_review_url" type="url" placeholder="https://g.page/r/.../review"></label><label class="full">Additional approved services (optional, one per line — specialty preset services are loaded automatically)<textarea name="services" placeholder="Leave blank to load the specialty preset services automatically"></textarea></label></div><div class="form-actions"><button class="primary">Create clinic workspace →</button></div></form></section>`;
    return;
  }
  ({
    overview: renderOverview,
    appointments: renderAppointments,
    queue: renderQueue,
    inbox: renderInbox,
    delivery: renderDelivery,
    settings: renderSettings,
    demo: renderDemo,
    waitlist: renderWaitlist,
    enquiries: renderEnquiries,
    recalls: renderRecalls,
    reports: renderReports,
    reviews: renderReviews,
    voice: renderVoice,
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
function clinicTodayStr() {
  try {
    return new Date().toLocaleDateString("en-CA", {
      timeZone: state.clinic?.timezone || "Asia/Kolkata",
    });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
async function refreshTimeline() {
  const wrap = $("#quick-timeline");
  if (!wrap || state.view !== "appointments" || !state.clinic) return;
  const clinicId = state.clinic.id;
  const day = state.timelineDay || clinicTodayStr();
  const params = new URLSearchParams({ clinic_id: String(clinicId), day });
  if (state.timelineDoctor) params.set("doctor_id", String(state.timelineDoctor));
  try {
    const data = await api(`/api/schedule/timeline?${params}`);
    if (!$("#quick-timeline") || state.clinic.id !== clinicId) return;
    if (data.closed) {
      wrap.innerHTML = `<p class="hint">Clinic / ${esc(data.doctor)} is closed on ${esc(data.date)}.</p>`;
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    wrap.innerHTML = `<div class="timeline-grid">${data.slots
      .map((s) => {
        if (s.status === "break") {
          return `<div class="slot-tile is-break"><strong>${esc(s.time_label)}</strong><small>Break</small></div>`;
        }
        if (s.status === "past") {
          return `<div class="slot-tile is-past"><strong>${esc(s.time_label)}</strong><small>Passed</small></div>`;
        }
        if (s.status === "available") {
          return `<button type="button" class="slot-tile is-open ${s.walkin_priority ? "is-peak" : ""}" data-action="quick-block-slot" data-iso="${esc(s.iso)}" data-doctor="${s.doctor_id}" data-service="${s.service_id}" title="Click to block this slot for a walk-in or phone call"><strong>${esc(s.time_label)}</strong><small>${s.walkin_priority ? "Peak · Tap to block" : "Open · Tap to block"}</small></button>`;
        }
        if (s.status === "held") {
          const secs = Math.max(1, (s.hold_expires || now) - now);
          const mins = Math.ceil(secs / 60);
          return `<div class="slot-tile is-held" title="A patient selected this slot on WhatsApp and has ${mins}m to reply YES"><strong>${esc(s.time_label)}</strong><small>WhatsApp hold · ${mins}m</small></div>`;
        }
        if (s.status === "blocked") {
          return `<button type="button" class="slot-tile is-blocked" data-action="edit-patient" data-id="${s.appointment_id}" title="Quick-blocked slot — click to add patient name or release"><strong>${esc(s.time_label)}</strong><small>${esc(s.patient_name || "Blocked")}</small></button>`;
        }
        return `<button type="button" class="slot-tile is-booked" data-action="edit-patient" data-id="${s.appointment_id}" title="Booked — click to update patient details"><strong>${esc(s.time_label)}</strong><small>${esc(s.patient_name || "Booked")} · ${esc(s.source || "")}</small></button>`;
      })
      .join("")}</div>`;
  } catch (e) {
    wrap.innerHTML = `<p class="hint">${esc(e.message)}</p>`;
  }
}
function renderAppointments() {
  const rows = state.appts;
  const dayVal = state.timelineDay || clinicTodayStr();
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-heading"><div><h3>One-tap desk timeline</h3><p>Tap any open slot to block it immediately for a phone call or walk-in—WhatsApp stops offering it right away. Add the patient’s name later when the desk is quiet.</p></div><div class="actions"><input id="timeline-day" type="date" value="${esc(dayVal)}" aria-label="Timeline date"><button class="secondary" data-action="refresh-timeline">Refresh slots</button></div></div><div class="timeline-legend"><span><i class="dot-open"></i> Open (tap to block)</span><span><i class="dot-peak"></i> Walk-in priority (request only)</span><span><i class="dot-held"></i> 5-min WhatsApp hold</span><span><i class="dot-blocked"></i> Desk quick-block</span><span><i class="dot-booked"></i> Confirmed</span></div><div id="quick-timeline"><p class="hint">Loading today’s slots…</p></div></section><section class="panel"><div class="panel-heading"><div><h3>All appointments</h3><p>WhatsApp, phone, and walk-in bookings in one live schedule.</p></div><button class="primary" data-action="new-appointment">+ Book appointment</button></div><div class="toolbar"><input id="appointment-search" placeholder="Search patient or contact" aria-label="Search appointments"><select id="appointment-filter" class="status-filter" aria-label="Filter appointments"><option value="">All statuses</option>${["confirmed", "completed", "no_show", "cancelled"].map((s) => `<option>${s}</option>`).join("")}</select><button class="secondary" data-action="export">Export CSV</button></div><div class="table-wrap"><table><thead><tr><th>Patient</th><th>Appointment</th><th>Status</th><th>Source</th><th>Actions</th></tr></thead><tbody id="appointment-rows">${rows.map((a) => appointmentRow(a)).join("")}</tbody></table></div>${!rows.length ? empty("No appointments yet", "Tap a slot above to quick-block, book manually, or let patients confirm on WhatsApp.") : ""}</section>`;
  refreshTimeline();
}
function appointmentRow(a) {
  return `<tr data-search="${esc((a.name + " " + a.contact).toLowerCase())}" data-status="${a.status}"><td><strong>${esc(a.name)}</strong><small>${esc(a.contact || "No phone entered yet")}</small></td><td>${esc(a.label)}<small>${esc(a.doctor || "")} · ${esc(a.service || "")}</small><small>#${a.id}${a.paid_amount ? " · " + money(a.paid_amount) : ""}${a.reminder_response && a.reminder_response !== "pending" ? " · reminder: " + esc(a.reminder_response.replaceAll("_", " ")) : ""}</small></td><td>${pill(a.status, a.status === "confirmed" || a.status === "completed" ? "good" : "")}</td><td>${pill(a.is_quick_block ? "quick-block" : a.source, a.source === "demo" ? "warn" : "")}</td><td><div class="actions">${a.status === "confirmed" ? `<button class="secondary" data-action="edit-patient" data-id="${a.id}">${a.is_quick_block ? "Add details" : "Edit"}</button><button class="secondary" data-action="complete" data-id="${a.id}">Complete</button><button class="secondary" data-action="reschedule" data-id="${a.id}">Move</button><button class="quiet" data-action="no-show" data-id="${a.id}">No-show</button><button class="danger" data-action="cancel" data-id="${a.id}">Cancel</button>` : ""}<button class="quiet" data-action="payment" data-id="${a.id}">Record payment</button></div></td></tr>`;
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
    walkin_windows: [],
  };
  const ww = (s.walkin_windows || [])[0] || {};
  return `<div class="form-grid"><label>Clinic name<input name="name" value="${esc(c.name || "")}" required maxlength="120"></label><label>Doctor name<input name="doctor" value="${esc(c.doctor || "")}" required maxlength="120"></label><label>Clinic phone<input name="phone" value="${esc(c.phone || "")}" placeholder="+919…" required></label><label>Consultation fee (₹)<input name="fee" type="number" min="0" value="${c.fee ?? 500}" required></label><label class="full">Address<input name="address" value="${esc(c.address || "")}" required maxlength="600"></label><label>Timezone<select name="timezone">${["Asia/Kolkata", "UTC"].map((z) => `<option ${c.timezone === z ? "selected" : ""}>${z}</option>`).join("")}</select></label><label>Appointment duration (minutes)<input name="duration" type="number" min="5" max="120" value="${s.duration}" required></label><label>Opens<input name="open" type="time" value="${s.open}" required></label><label>Closes<input name="close" type="time" value="${s.close}" required></label><label>Break starts (optional)<input name="break_start" type="time" value="${s.breaks[0]?.start || ""}"></label><label>Break ends<input name="break_end" type="time" value="${s.breaks[0]?.end || ""}"></label><label>Peak walk-in priority starts (optional)<input name="walkin_start" type="time" value="${ww.start || ""}"></label><label>Peak walk-in priority ends<input name="walkin_end" type="time" value="${ww.end || ""}"></label><p class="hint full">During a walk-in priority window, WhatsApp marks slots as <em>request only</em> and routes patient requests to your inbox instead of auto-confirming.</p><div class="full"><label>Closed days</label><div class="status-line">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<label class="check-label"><input type="checkbox" name="closed_days" value="${i}" ${s.closed_days.includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div></div><label class="full">Leave dates (one YYYY-MM-DD per line)<textarea name="leave_dates">${esc(s.leave_dates.join("\n"))}</textarea></label><label class="full">Authorized staff WhatsApp numbers (one per line)<textarea name="staff_phones" placeholder="+919876543210">${esc((c.staff_phones || []).join("\n"))}</textarea><p class="hint">Receptionists and doctors listed here can text <code>BLOCK 11:00 Ramesh</code>, <code>WALKIN 4:30</code>, <code>UNBLOCK 11:00</code>, or <code>SLOTS</code> to your clinic WhatsApp number to update availability in 2 seconds.</p></label><label class="full">Google Review link (for 4–5 star post-visit ratings)<input name="google_review_url" type="url" value="${esc(c.google_review_url || "")}" placeholder="https://g.page/r/.../review" maxlength="500"><p class="hint">When a completed visit receives a 4 or 5 rating, Jyutrix sends this link. Ratings of 1–3 never receive the link and are routed privately to your inbox.</p></label><label class="full">Website chat widget greeting<input name="widget_greeting" value="${esc(c.widget_greeting || "")}" placeholder="Hi! Ask about consultation fees, timings, or book on WhatsApp." maxlength="300"></label><label class="full">Approved service descriptions (one per line)<textarea name="services">${esc((c.services || ["Dental consultation"]).join("\n"))}</textarea><p class="hint">Patient-facing approved descriptions. Booking duration and fee are configured separately in Growth scheduling below.</p></label><label>WhatsApp phone number ID<input name="number_id" value="${esc(c.number_id || "")}" placeholder="From Kapso" ${state.user.role !== "admin" ? "disabled" : ""}></label><label>Monthly outgoing message allowance<input name="monthly_limit" type="number" min="1" value="${c.monthly_limit ?? 2000}" ${state.user.role !== "admin" ? "disabled" : ""}></label><label>Plan<select name="plan" ${state.user.role !== "admin" ? "disabled" : ""}>${["Pilot", "Starter", "Growth"].map((p) => `<option value="${p}" ${(c.plan || "Pilot") === p ? "selected" : ""}>${p}</option>`).join("")}</select></label><label>Monthly subscription (₹)<input name="monthly_fee" type="number" min="0" value="${c.monthly_fee ?? 4999}" ${state.user.role !== "admin" ? "disabled" : ""}></label><label>Plan expiry (optional)<input name="pilot_end" type="date" value="${c.pilot_end ? new Date(c.pilot_end * 1000).toISOString().slice(0, 10) : ""}" ${state.user.role !== "admin" ? "disabled" : ""}></label><div class="status-line"><label class="check-label"><input name="enabled" type="checkbox" ${c.enabled ? "checked" : ""}>Enable automated replies</label><label class="check-label"><input name="widget_enabled" type="checkbox" ${c.widget_enabled !== false ? "checked" : ""}>Enable embeddable website chat widget</label><label class="check-label"><input name="review_requests_enabled" type="checkbox" ${c.review_requests_enabled !== false ? "checked" : ""}>Send post-visit review check on completion</label><label class="check-label"><input name="template_approved" type="checkbox" ${c.template_approved ? "checked" : ""}>Reminder template approved</label><label class="check-label"><input name="reminder_buttons_approved" type="checkbox" ${c.reminder_buttons_approved ? "checked" : ""}>Quick-reply reminder template approved</label><p class="hint">Quick replies require a separate approved template with Confirm, Reschedule and Cancel buttons. See docs/KAPSO.md before enabling.</p></div><div class="full"><label>Approved questions & answers</label><p class="hint">Only add administrative answers approved by the clinic.</p><div id="faq-rows">${(c.faqs || []).map((f) => faqRow(f)).join("")}</div><button type="button" class="secondary" data-action="add-faq">+ Add answer</button></div></div>`;
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
      walkin_windows:
        d.get("walkin_start") && d.get("walkin_end")
          ? [{ start: d.get("walkin_start"), end: d.get("walkin_end") }]
          : [],
      leave_dates: String(d.get("leave_dates"))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    staff_phones: String(d.get("staff_phones") || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
    google_review_url: String(d.get("google_review_url") || "").trim() || null,
    review_requests_enabled: d.has("review_requests_enabled"),
    widget_enabled: d.has("widget_enabled"),
    widget_greeting: String(d.get("widget_greeting") || "").trim(),
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
  const ww = (schedule.walkin_windows || [])[0] || {};
  return `<form id="growth-doctor-form" data-id="${doctor.id || ""}"><div class="form-grid"><label>Doctor name<input name="name" value="${esc(doctor.name || "")}" required minlength="2" maxlength="120"></label><label>Opens<input name="open" type="time" value="${schedule.open}" required></label><label>Closes<input name="close" type="time" value="${schedule.close}" required></label><label>Appointment duration (minutes)<input name="duration" type="number" min="5" max="120" value="${schedule.duration}" required></label><label>Break starts<input name="break_start" type="time" value="${schedule.breaks[0]?.start || ""}"></label><label>Break ends<input name="break_end" type="time" value="${schedule.breaks[0]?.end || ""}"></label><label>Walk-in priority starts<input name="walkin_start" type="time" value="${ww.start || ""}"></label><label>Walk-in priority ends<input name="walkin_end" type="time" value="${ww.end || ""}"></label><div class="full"><label>Closed days</label><div class="status-line">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => `<label class="check-label"><input type="checkbox" name="closed_days" value="${i}" ${(schedule.closed_days || []).includes(i) ? "checked" : ""}>${d}</label>`).join("")}</div></div><label class="full">Leave dates (one YYYY-MM-DD per line)<textarea name="leave_dates">${esc((schedule.leave_dates || []).join("\n"))}</textarea></label><label class="check-label"><input type="checkbox" name="active" ${doctor.active === false ? "" : "checked"}> Active for new bookings</label></div><div class="form-actions"><button class="primary">Save doctor</button></div></form>`;
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
      walkin_windows:
        data.get("walkin_start") && data.get("walkin_end")
          ? [{ start: data.get("walkin_start"), end: data.get("walkin_end") }]
          : [],
      leave_dates: String(data.get("leave_dates")).split("\n").map((s) => s.trim()).filter(Boolean),
    },
  };
}
async function renderGrowthCatalog() {
  const target = $("#growth-catalog-content");
  if (!target) return;
  try {
    const clinicId = state.clinic.id;
    const [entitlements, doctors, services, presets] = await Promise.all([
      api(`/api/clinics/${clinicId}/entitlements`),
      api(`/api/doctors?clinic_id=${clinicId}`),
      api(`/api/services?clinic_id=${clinicId}`),
      state.presets.length ? Promise.resolve(state.presets) : api("/api/vertical-presets"),
    ]);
    state.entitlements = entitlements;
    state.doctors = doctors;
    state.services = services;
    state.presets = presets;
    if (!$("#growth-catalog-content")) return;
    const editable = state.user.role !== "receptionist";
    const canAddDoctor = editable && entitlements.usage.doctors < entitlements.limits.max_doctors;
    const canAddService = editable && entitlements.usage.services < entitlements.limits.max_services;
    const presetHtml = editable
      ? `<div class="preset-bar"><strong>1-click specialty catalog</strong><select id="preset-select" aria-label="Specialty preset">${presets.map((p) => `<option value="${esc(p.id)}" ${state.clinic.vertical === p.id ? "selected" : ""}>${esc(p.label)} (${p.services.length} services)</option>`).join("")}</select><button type="button" class="secondary" data-action="apply-preset">Load services &amp; FAQs</button></div>`
      : "";
    target.innerHTML = `${presetHtml}<div class="status-line">${pill(`${entitlements.plan} plan`)}${pill(`${entitlements.usage.doctors}/${entitlements.limits.max_doctors} doctors`)}${pill(`${entitlements.usage.services}/${entitlements.limits.max_services} services`)}</div><p class="hint">Growth supports up to five active doctors with doctor-specific schedules. Your current plan caps are enforced on the server. The cancellation waitlist is available on Growth; payment links are not available yet.</p><div class="two-col"><section><div class="panel-heading"><h3>Doctors</h3>${editable ? `<button class="secondary" data-action="new-doctor" ${canAddDoctor ? "" : "disabled title=\"Plan doctor limit reached\""}>+ Add doctor</button>` : ""}</div>${doctors.map((doctor) => `<div class="list-row"><div><strong>${esc(doctor.name)}</strong><p>${esc(doctor.schedule.open)}–${esc(doctor.schedule.close)} · ${doctor.schedule.duration} min · ${doctor.active ? "active" : "inactive"}</p></div>${editable ? `<button class="secondary" data-action="edit-doctor" data-id="${doctor.id}">Edit</button>` : ""}</div>`).join("")}</section><section><div class="panel-heading"><h3>Services</h3>${editable ? `<button class="secondary" data-action="new-service" ${canAddService ? "" : "disabled title=\"Plan service limit reached\""}>+ Add service</button>` : ""}</div>${services.map((service) => `<div class="list-row"><div><strong>${esc(service.name)}</strong><p>${service.duration} min · ${money(service.fee)} · ${service.active ? "active" : "inactive"}</p></div>${editable ? `<button class="secondary" data-action="edit-service" data-id="${service.id}">Edit</button>` : ""}</div>`).join("")}</section></div>`;
  } catch (error) {
    toast(error.message, true);
  }
}

function renderSettings() {
  const c = state.clinic;
  const canManageStaff = state.user.role === "admin" || state.user.role === "owner";
  const showPasswordPanel = state.user.auth_provider !== "clerk";
  const voiceUrl = `${location.origin}/api/voice/tools`;
  const voiceWebhookUrl = `${location.origin}/api/voice/webhook`;
  const widgetSnippet = `<script src="${location.origin}/widget.js" data-clinic-id="${c.id}" async></script>`;
  $("#content").innerHTML =
    `<section class="panel"><div class="panel-heading"><div><h3>Approved clinic information</h3><p>This information guides patient replies and appointment availability.</p></div>${state.user.role === "admin" ? '<button class="secondary" data-action="new-clinic">+ Add clinic</button>' : ""}</div>${state.user.role === "receptionist" ? '<p class="hint">Ask the clinic owner to update settings.</p>' : `<form id="settings-form">${clinicFields(c)}<div class="form-actions"><button class="primary">Save clinic settings</button><p class="hint">Schedule changes affect new bookings. Review existing appointments separately.</p></div></form>`}</section><section class="panel"><div class="panel-heading"><div><h3>Embeddable Website Chat &amp; Lead Widget</h3><p>Paste this 1-line script before <code>&lt;/body&gt;</code> on the clinic’s website. Answers approved FAQs, captures callback leads directly into your <strong>Enquiries</strong> tab, and hands off to WhatsApp booking.</p></div>${pill(c.widget_enabled !== false ? "Widget active" : "Widget paused", c.widget_enabled !== false ? "good" : "warn")}</div><code id="widget-embed-code" class="embed-code">${esc(widgetSnippet)}</code><div class="actions"><button type="button" class="secondary" data-action="copy-widget-snippet">Copy 1-line embed snippet</button><button type="button" class="primary" data-action="preview-widget">Test widget live →</button></div></section><section class="panel"><h3>WhatsApp activation</h3><div class="setup-step"><span>1</span><div><strong>Connect the clinic’s number in Kapso</strong><p>Use the clinic-owned account. Save its phone number ID above.</p></div></div><div class="setup-step"><span>2</span><div><strong>Register the clinic webhook</strong><p>Use the Meta payload option and the secret configured on the server. Your deployment guide contains the setup command.</p></div></div><div class="setup-step"><span>3</span><div><strong>Approve the reminder template and test</strong><p>Check booking, cancellation, staff takeover and message delivery from a real patient number before activation.</p></div></div><div class="status-line">${pill(state.status.kapso_configured ? "Credentials configured" : "Credentials missing", state.status.kapso_configured ? "good" : "warn")}${pill(state.status.database === "postgresql" ? "PostgreSQL connected" : "In-memory demo storage", state.status.database === "postgresql" ? "good" : "warn")}${pill(state.status.ai_mode)}</div></section><section class="panel"><div class="panel-heading"><div><h3>Inbound AI Voice Receptionist (Vapi / Bolna / Plivo)</h3><p>Connect your voice AI provider to check live slots, log booking requests with a 5-minute soft hold, and meter monthly call minutes.</p></div>${pill(state.status.voice_tools_configured ? "VOICE_TOOL_KEY configured" : "Set VOICE_TOOL_KEY on server", state.status.voice_tools_configured ? "good" : "warn")}</div><p class="hint">Point your voice agent tool webhook to the Tool URL below with header <code>Authorization: Bearer &lt;VOICE_TOOL_KEY&gt;</code> and <code>clinic_id: ${c.id}</code>. Supported actions: <code>info</code>, <code>availability</code>, and <code>request</code>.</p><div class="copy-row"><code id="voice-tool-url">${esc(voiceUrl)}</code><button type="button" class="secondary" data-action="copy-voice-url">Copy Tool URL</button></div><p class="hint" style="margin-top:12px">Point your provider’s <strong>end-of-call / call-completed webhook</strong> to the Metering URL below to log duration, billable minutes, outcomes, and transcripts automatically in the <strong>Voice AI</strong> tab:</p><div class="copy-row"><code id="voice-webhook-url">${esc(voiceWebhookUrl)}</code><button type="button" class="secondary" data-action="copy-voice-webhook">Copy Metering URL</button></div></section><section class="panel"><div class="panel-heading"><div><h3>Growth scheduling</h3><p>Manage doctor-specific availability, service durations, and specialty presets.</p></div></div><div id="growth-catalog-content"><p class="hint">Loading Growth plan details…</p></div></section>${canManageStaff ? `<section class="panel"><div class="panel-heading"><h3>Clinic staff access</h3><button class="secondary" data-action="new-user">+ Add staff account</button></div><div id="users-list"></div></section>` : ""}${showPasswordPanel ? `<section class="panel password-panel"><h3>Change your password</h3><form id="password-form"><div class="form-grid"><label>Current password<input name="current" type="password" required autocomplete="current-password"></label><label>New password (16+ characters)<input name="new" type="password" required minlength="16" maxlength="128" autocomplete="new-password"></label></div><div class="form-actions"><button class="secondary">Change password & sign out</button></div></form></section>` : ""}`;
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
function renderReviews() {
  $("#content").innerHTML = `<section class="panel"><div class="panel-heading"><div><h3>Post-visit reviews &amp; private recovery</h3><p>When reception marks an appointment completed, Jyutrix sends a 1–5 feedback check on WhatsApp. Ratings 4–5 get your Google Review link; ratings 1–3 stay private and alert your inbox.</p></div><button class="secondary" data-view="settings">Configure review link</button></div><div id="reviews-body"><p class="hint">Loading patient reviews…</p></div></section>`;
  api(`/api/reviews?clinic_id=${state.clinic.id}`)
    .then((data) => {
      state.reviews = data;
      const target = $("#reviews-body");
      if (!target || state.view !== "reviews") return;
      const s = data.summary;
      const stars = (n) => (n ? `<span class="star-rating">${"★".repeat(n)}${"☆".repeat(5 - n)}</span> ${n}/5` : "Awaiting reply");
      const statusPill = (st) =>
        st === "happy_link_sent"
          ? pill("Google link sent", "good")
          : st === "escalated"
            ? pill("Private escalation", "bad")
            : pill("Waiting for rating", "warn");
      const cards = [
        ["Feedback checks sent", s.total, `${s.pending} awaiting reply`],
        ["Average rating", s.average_rating !== null ? `★ ${s.average_rating}` : "—", `${s.responses} patient rating(s)`],
        ["Google links sent", s.happy_links_sent, "4–5 star visits"],
        ["Private escalations", s.escalated, "1–3 star visits caught before Google"],
      ];
      target.innerHTML = `<div class="status-line" style="margin-bottom:16px">${pill(data.review_requests_enabled ? "Auto post-visit check ON" : "Auto post-visit check OFF", data.review_requests_enabled ? "good" : "warn")}${pill(data.google_review_url ? "Google Review link configured" : "Add Google Review link in Settings", data.google_review_url ? "good" : "warn")}</div><div class="metrics">${cards.map(([l, v, sub]) => `<div class="metric"><p>${esc(l)}</p><strong>${esc(v)}</strong><small>${esc(sub)}</small></div>`).join("")}</div>${
        data.items.length
          ? `<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Rating</th><th>Outcome</th><th>Feedback note</th><th>Requested</th><th></th></tr></thead><tbody>${data.items.map((r) => `<tr><td><strong>${esc(r.patient_name)}</strong><small>${esc(r.contact)} · Appt #${r.appointment_id}</small></td><td>${stars(r.rating)}</td><td>${statusPill(r.status)}</td><td>${esc(r.feedback_note || "—")}</td><td>${esc(stamp(r.created))}</td><td>${r.thread_id ? `<button class="secondary" data-action="open-thread" data-id="${r.thread_id}">Open chat</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
          : empty("No review checks sent yet", "Mark any appointment as Completed on the Appointments tab to send an automatic 1–5 feedback check.")
      }`;
    })
    .catch((e) => toast(e.message, true));
}

function paintCopilotResult() {
  const target = $("#copilot-result");
  if (!target) return;
  const res = state.copilotResult;
  if (!res) {
    target.innerHTML = "";
    return;
  }
  target.innerHTML = `<div class="copilot-answer"><p>${esc(res.answer)}</p><div class="copilot-meta">${pill(res.intent.replaceAll("_", " "), "good")}<span>${esc(res.period)}</span><span>Read-only verified clinic totals</span></div></div>`;
}

function formatDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${String(rem).padStart(2, "0")}s`;
}

function paintVoice() {
  const target = $("#voice-body");
  if (!target || state.view !== "voice" || !state.voice) return;
  const { usage: u, packs, calls } = state.voice;
  const canEdit = state.user.role !== "receptionist";
  const isDemo = state.user.mode !== "production";
  const meterClass = u.alert_level === "exceeded" ? "bad" : u.alert_level === "warning" ? "warn" : "";
  const meterWidth = Math.min(100, Math.max(0, u.usage_percent || 0));
  const alertHtml =
    u.alert_level === "exceeded" || u.alert_level === "warning"
      ? `<div class="voice-alert ${meterClass}">${esc(u.alert_message)}</div>`
      : "";
  const outcomePill = (o) => {
    const label = String(o || "").replaceAll("_", " ");
    if (o === "booking_requested" || o === "reminder_confirmed") return pill(label, "good");
    if (o === "transferred") return pill(label, "warn");
    if (o === "missed" || o === "voicemail") return pill(label, "bad");
    return pill(label);
  };
  const marginText =
    state.user.role === "admin"
      ? `Est. cost ${money(u.estimated_provider_cost_inr)} · Contrib. ${money(u.estimated_contribution_inr)}`
      : `${money(u.pack_monthly_fee)}/mo · Extra ₹${u.extra_rate_inr}/min`;

  const cards = `
    <div class="metrics">
      <div class="metric">
        <p>Minutes used (${esc(u.month)})</p>
        <strong>${u.minutes_used} <small>/ ${u.minutes_included} min</small></strong>
        <div class="voice-meter ${meterClass}"><i style="width:${meterWidth}%"></i></div>
        <small>${u.usage_percent}% of monthly pack · alert at ${u.alert_threshold_pct}%</small>
      </div>
      <div class="metric">
        <p>Voice calls this month</p>
        <strong>${u.total_calls}</strong>
        <small>${u.inbound_calls} inbound · ${u.outbound_calls} outbound · ${u.booking_requests} booking req</small>
      </div>
      <div class="metric">
        <p>${u.overage_minutes > 0 ? "Overage minutes" : "Minutes remaining"}</p>
        <strong>${u.overage_minutes > 0 ? `+${u.overage_minutes} min` : `${u.minutes_remaining} min`}</strong>
        <small>${u.overage_minutes > 0 ? `Extra charge: ${money(u.overage_charge_inr)} (₹${u.extra_rate_inr}/min)` : `Avg call: ${formatDur(u.avg_duration_seconds)}`}</small>
      </div>
      <div class="metric">
        <p>Active voice pack</p>
        <strong style="font-size:20px">${esc(u.pack_label.split("—")[0].trim())}</strong>
        <small>${esc(marginText)}</small>
      </div>
    </div>
  `;

  const packPanel = canEdit
    ? `<section class="panel"><div class="panel-heading"><div><h3>Prepaid minute pack &amp; usage alerts</h3><p>Meter every connected AI call against prepaid monthly minutes so voice telephony costs never run unmonitored.</p></div><button type="button" class="secondary" data-view="settings">Voice webhook setup</button></div><form id="voice-pack-form"><div class="form-grid"><label>Monthly voice minute pack<select name="voice_pack">${packs.map((p) => `<option value="${esc(p.id)}" ${p.id === u.pack_id ? "selected" : ""}>${esc(p.label)}${p.monthly_fee ? ` · ${money(p.monthly_fee)}/mo` : ""}</option>`).join("")}</select></label><label>Warning alert threshold (%)<input name="voice_alert_threshold_pct" type="number" min="50" max="99" value="${u.alert_threshold_pct}" required></label></div><div class="form-actions"><button class="primary">Save voice pack</button><p class="hint">Extra minutes beyond pack allowance are tracked at ₹${u.extra_rate_inr}/min.</p></div></form></section>`
    : "";

  const logPanel = `<section class="panel"><div class="panel-heading"><div><h3>AI voice call log &amp; transcripts</h3><p>Inbound &amp; outbound AI calls recorded via <code>POST /api/voice/webhook</code> (Vapi, Bolna, Plivo, Retell).</p></div><div class="actions">${isDemo && canEdit ? `<button type="button" class="primary" data-action="simulate-voice-call">+ Simulate AI voice call</button>` : ""}<button type="button" class="secondary" data-action="refresh-voice">Refresh</button></div></div>${
    calls.length
      ? `<div class="table-wrap"><table><thead><tr><th>Caller</th><th>Channel</th><th>Duration / Billable</th><th>Outcome</th><th>Summary</th><th>Time</th><th></th></tr></thead><tbody>${calls
          .map(
            (c) =>
              `<tr><td><strong>${esc(c.caller_name)}</strong><small>${esc(c.contact || "No caller ID")}</small></td><td>${pill(c.direction, c.direction === "inbound" ? "good" : "")} <small>${esc(c.provider)}</small></td><td><strong>${c.billable_minutes} min</strong><small>${formatDur(c.duration_seconds)}</small></td><td>${outcomePill(c.outcome)}</td><td>${esc(c.summary || "—")}</td><td>${esc(stamp(c.created))}</td><td><div class="actions">${c.transcript ? `<button type="button" class="secondary" data-action="view-transcript" data-id="${c.id}">Transcript</button>` : ""}${c.thread_id ? `<button type="button" class="quiet" data-action="open-thread" data-id="${c.thread_id}">Chat</button>` : ""}</div></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty(
          "No voice calls logged yet",
          "Connect your Vapi/Bolna end-of-call webhook in Clinic Settings or simulate a call in demo mode.",
        )
  }</section>`;

  target.innerHTML = `${alertHtml}${cards}${packPanel}${logPanel}`;
}

function renderVoice() {
  $("#content").innerHTML = `<div id="voice-body"><p class="hint">Loading voice usage and call logs…</p></div>`;
  api(`/api/voice/calls?clinic_id=${state.clinic.id}`)
    .then((data) => {
      state.voice = data;
      paintVoice();
    })
    .catch((e) => toast(e.message, true));
}

async function refreshQueue() {
  if (!state.clinic || state.view !== "queue") return;
  const date = state.queueDate || clinicTodayStr();
  const data = await api(`/api/queue?clinic_id=${state.clinic.id}&date=${encodeURIComponent(date)}`);
  state.queue = data;
  paintQueue();
}

function paintQueue() {
  const target = $("#queue-body");
  if (!target || !state.queue) return;
  const q = state.queue;
  const canEdit = state.user.role !== "receptionist";
  const modes = [
    ["slots", "Fixed time slots"],
    ["tokens", "Token queue only"],
    ["hybrid", "Hybrid (slots + tokens)"],
  ];
  const modeBar = `<section class="panel"><div class="panel-heading"><div><h3>Clinic booking workflow</h3><p>Choose whether patients book fixed clock slots, Morning/Evening queue tokens, or both. In <strong>Hybrid</strong> or <strong>Token queue</strong> mode, WhatsApp patients can text <code>TOKEN</code> to join the live queue.</p></div><div class="actions"><input id="queue-date" type="date" value="${esc(q.date)}" aria-label="Queue date"><button type="button" class="secondary" data-action="refresh-queue">Refresh board</button></div></div><div class="chips">${modes.map(([val, label]) => `<button type="button" class="chip ${q.booking_mode === val ? "active" : ""}" data-action="set-booking-mode" data-mode="${val}" ${canEdit ? "" : "disabled"}>${esc(label)}</button>`).join("")}</div></section>`;

  const cards = `<div class="queue-grid">${q.sessions
    .map((s) => {
      const tokenRows = s.tokens.length
        ? `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Patient</th><th>Status</th><th>Actions</th></tr></thead><tbody>${s.tokens
            .map(
              (t) =>
                `<tr><td><span class="token-badge ${t.status === "serving" ? "serving" : ""}">#${t.token_number}</span></td><td><strong>${esc(t.patient_name)}</strong><small>${esc(t.contact || "Walk-in")} · ${esc(t.source)}</small></td><td>${pill(t.status, t.status === "serving" || t.status === "completed" ? "good" : t.status === "skipped" ? "warn" : "")}</td><td><div class="actions">${t.status === "waiting" ? `<button type="button" class="secondary" data-action="token-status" data-id="${t.id}" data-status="serving">Call</button><button type="button" class="quiet" data-action="token-status" data-id="${t.id}" data-status="skipped">Skip</button>` : ""}${t.status === "serving" ? `<button type="button" class="secondary" data-action="token-status" data-id="${t.id}" data-status="completed">Done</button>` : ""}${["waiting", "serving"].includes(t.status) ? `<button type="button" class="danger" data-action="token-status" data-id="${t.id}" data-status="cancelled">Cancel</button>` : ""}</div></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty("No tokens issued yet", "Tap “+ Issue token” for a walk-in/phone patient or text TOKEN in Demo/WhatsApp.");
      return `<section class="queue-card"><div class="panel-heading" style="margin-bottom:0"><div><h3>${esc(s.label)}</h3><p>${esc(s.start)}–${esc(s.end)} · ~${s.avg_minutes} min/patient</p></div><div class="actions"><button type="button" class="secondary" data-action="issue-token" data-session="${esc(s.id)}">+ Issue token</button><button type="button" class="primary" data-action="queue-next" data-session="${esc(s.id)}" ${s.waiting_count === 0 && !s.now_serving ? "disabled" : ""}>Call next →</button></div></div><div class="token-now"><div><small class="eyebrow" style="margin:0">NOW SERVING</small><strong>${s.now_serving ? "#" + s.now_serving : "Idle"}</strong><p>${esc(s.now_serving_patient || "Ready to call next token")}</p></div><div>${pill(`Next #${s.next_token}`, "good")}</div></div><div class="token-stats"><div class="token-stat"><small>Waiting</small><strong>${s.waiting_count}</strong></div><div class="token-stat"><small>Est. wait</small><strong>~${s.estimated_wait_minutes}m</strong></div><div class="token-stat"><small>Capacity left</small><strong>${s.remaining_capacity}/${s.max_tokens}</strong></div></div>${tokenRows}</section>`;
    })
    .join("")}</div>`;

  target.innerHTML = `${modeBar}${cards}`;
}

function renderQueue() {
  $("#content").innerHTML = `<div id="queue-body"><p class="hint">Loading live token queue…</p></div>`;
  refreshQueue().catch((e) => toast(e.message, true));
}

async function refreshRecalls() {
  if (!state.clinic || state.view !== "recalls") return;
  const clinicId = state.clinic.id;
  const params = new URLSearchParams({ clinic_id: String(clinicId), kind: state.recallKind });
  if (state.recallDays !== "" && state.recallDays !== null) params.set("days", String(state.recallDays));
  const [candData, campaigns] = await Promise.all([
    api(`/api/recalls/candidates?${params}`),
    api(`/api/recalls/campaigns?clinic_id=${clinicId}`),
  ]);
  state.recalls = candData;
  state.recallCampaigns = campaigns;
  paintRecalls();
}

function paintRecalls() {
  const target = $("#recalls-body");
  if (!target || !state.recalls) return;
  const r = state.recalls;
  const canLaunch = state.user.role !== "receptionist";
  const c = r.counts;
  const metricsHtml = `<div class="metrics">${[
    ["Matching past patients", c.total, "No upcoming visit booked"],
    ["Eligible to nudge", c.eligible, "Consented & not opted out"],
    ["Auto-skipped (opt-out)", c.opted_out, "STOP strictly honored"],
    ["Campaigns launched", state.recallCampaigns.length, "Tracked recall runs"],
  ]
    .map(([l, v, s]) => `<div class="metric"><p>${l}</p><strong>${esc(v)}</strong><small>${s}</small></div>`)
    .join("")}</div>`;

  const builderHtml = `<section class="panel"><div class="panel-heading"><div><h3>Patient reactivation &amp; recall campaign</h3><p>Auto-nudge past patients due for a 6-month cleaning/checkup or who missed/cancelled a slot using approved WhatsApp templates. Opted-out contacts are automatically excluded.</p></div>${pill("Opt-out protected", "good")}</div><form id="recall-campaign-form"><div class="form-grid"><label>Campaign type<select id="recall-kind" name="kind">${r.templates.map((t) => `<option value="${esc(t.id)}" ${t.id === r.kind ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select></label><label>Visit age threshold (days)<input id="recall-days" name="days" type="number" min="0" max="3650" value="${esc(state.recallDays !== "" ? state.recallDays : r.template.default_days)}"><p class="hint">Use <code>180</code> for 6-month dental recalls, or <code>0</code> to preview recently completed visits in demo mode.</p></label><label>Approved WhatsApp template name<input name="template_name" value="${esc(r.template.template_name)}" required maxlength="120"></label><label>Campaign label<input name="name" value="${esc(r.template.label)}" required maxlength="140"></label><label class="full">Template message preview (use <code>{Patient}</code> for patient name)<textarea name="custom_message">${esc(r.template.preview)}</textarea></label></div><div class="form-actions">${canLaunch ? `<button class="primary" ${c.eligible === 0 ? "disabled" : ""}>Send recall nudge to ${c.eligible} eligible patient(s) →</button>` : `<p class="hint">Ask the clinic owner to launch recall campaigns.</p>`}<button type="button" class="secondary" data-action="refresh-recalls">Refresh candidates</button></div></form></section>`;

  const candidatesHtml = `<section class="panel"><div class="panel-heading"><div><h3>Candidate patients</h3><p>Patients with an upcoming confirmed visit are excluded automatically.</p></div></div>${
    r.candidates.length
      ? `<div class="table-wrap"><table><thead><tr><th>Patient</th><th>Last visit</th><th>Reason</th><th>Channel</th><th>Eligibility</th></tr></thead><tbody>${r.candidates
          .map(
            (p) =>
              `<tr><td><strong>${esc(p.patient_name)}</strong><small>${esc(p.contact)}</small></td><td>${esc(stamp(p.last_visit))}</td><td>${esc(p.reason)}</td><td>${pill(p.channel, p.channel === "demo" ? "warn" : "")}</td><td>${p.eligible ? pill("Eligible", "good") : p.opted_out ? pill("Opted out (skipped)", "bad") : pill("No consent (skipped)", "warn")}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty(
          "No past patients match this threshold yet",
          "Mark an appointment completed or cancelled (or set threshold days to 0 in demo mode) to preview recall candidates.",
        )
  }</section>`;

  const historyHtml = `<section class="panel"><div class="panel-heading"><div><h3>Past recall campaigns</h3><p>Audit trail of every recall run and how many opted-out contacts were protected.</p></div></div>${
    state.recallCampaigns.length
      ? `<div class="table-wrap"><table><thead><tr><th>Campaign</th><th>Template</th><th>Sent / Queued</th><th>Skipped (opt-out / no consent)</th><th>Launched</th></tr></thead><tbody>${state.recallCampaigns
          .map(
            (x) =>
              `<tr><td><strong>${esc(x.name)}</strong><small>${esc(x.kind)}</small></td><td><code>${esc(x.template_name)}</code></td><td>${pill(`${x.sent_count} / ${x.target_count}`, "good")}</td><td>${x.skipped_opted_out ? pill(`${x.skipped_opted_out} skipped`, "warn") : "0"}</td><td>${esc(stamp(x.created))}<small>by ${esc(x.created_by)}</small></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty("No recall campaigns launched yet", "Launch a campaign above to nudge overdue patients.")
  }</section>`;

  target.innerHTML = `${metricsHtml}${builderHtml}${candidatesHtml}${historyHtml}`;
}

function renderRecalls() {
  $("#content").innerHTML = `<div id="recalls-body"><p class="hint">Loading recall candidates…</p></div>`;
  refreshRecalls().catch((e) => toast(e.message, true));
}

function renderReports() {
  const r = state.reportPeriod;
  const canCopilot = state.user.role !== "receptionist";
  const copilotPanel = canCopilot
    ? `<section class="panel"><div class="panel-heading"><div><h3>Owner reporting copilot</h3><p>Ask questions about today’s bookings, conversion rates, busiest doctor, overdue follow-ups, voice minutes, or patient reviews. Backed strictly by verified clinic records (read-only).</p></div>${pill("Clinic-scoped", "good")}</div><form id="copilot-form" class="copilot-form"><input name="question" id="copilot-input" placeholder="Ask e.g. How many voice minutes have we used? or Appointments today?" required maxlength="400" aria-label="Ask reporting copilot"><button class="primary">Ask</button></form><div class="chips">${["Appointments today", "Enquiry conversion rate", "Busiest doctor this month", "Overdue follow-ups", "Patient review rating", "Voice AI minutes used", "Cancellation & no-show rate"].map((q) => `<button type="button" class="chip" data-action="copilot-chip" data-question="${esc(q)}">${esc(q)}</button>`).join("")}</div><div id="copilot-result"></div></section>`
    : "";
  $("#content").innerHTML = `${copilotPanel}<section class="panel"><div class="panel-heading"><div><h3>How the clinic is doing</h3><p>Operational counts from live records. Demo data is never included.</p></div><button class="secondary" data-action="export-report">Export CSV</button></div><div class="toolbar"><select id="report-period" aria-label="Report period">${PERIOD_OPTIONS.map(([k, v]) => `<option value="${k}" ${r.period === k ? "selected" : ""}>${v}</option>`).join("")}</select><input id="report-start" type="date" aria-label="Start date" value="${esc(r.start)}" ${r.period === "custom" ? "" : "hidden"}><input id="report-end" type="date" aria-label="End date" value="${esc(r.end)}" ${r.period === "custom" ? "" : "hidden"}></div></section><div id="report-body">Loading report…</div>`;
  paintCopilotResult();
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
    `<section class="panel"><div class="panel-heading"><div><h3>Try a patient conversation</h3><p>Same booking engine, separate demo records. No WhatsApp messages are sent.</p></div>${pill("Demo only", "warn")}</div><form id="demo-form"><div class="form-grid"><label>Patient name<input name="name" value="Demo patient" required></label><label>Demo contact<input name="contact" value="919999000001" required></label></div><div class="demo-chat" id="demo-chat">Send BOOK → choose 1 → send YES (or send TOKEN → choose 1 for queue mode). No booking is created until confirmation.</div><div class="demo-quick">${["Hello", "BOOK", "TOKEN", "1", "YES", "FEES", "RESCHEDULE", "CANCEL", "STAFF", "STOP", "START"].map((t) => `<button type="button" class="secondary" data-action="demo-quick" data-text="${t}">${t}</button>`).join("")}</div><div class="form-actions"><input name="text" placeholder="Type a patient message…" required maxlength="4000" aria-label="Demo patient message"><button class="primary">Send</button></div></form><p class="hint">The prototype recognizes selected Telugu/Hindi phrases; replies currently use English. Full translated conversation quality requires separate acceptance testing.</p></section>`;
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
    else if (action === "refresh-timeline") await refreshTimeline();
    else if (action === "quick-block-slot") {
      button.disabled = true;
      try {
        const created = await post("/api/appointments/quick-block", {
          clinic_id: state.clinic.id,
          scheduled_at: button.dataset.iso,
          doctor_id: Number(button.dataset.doctor) || undefined,
          service_id: Number(button.dataset.service) || undefined,
          kind: "walk_in",
        });
        await load();
        toast(`Blocked ${created.label} — WhatsApp won’t double-book it.`);
      } finally {
        button.disabled = false;
      }
    } else if (action === "edit-patient") {
      const a = state.appts.find((x) => x.id === id);
      if (!a) return;
      modal(
        "Update patient details",
        `<form id="edit-patient-form" data-id="${a.id}"><p class="hint">${esc(a.label)} · ${esc(a.doctor || "")}</p><div class="form-grid"><label>Patient name<input name="name" value="${esc(a.name)}" required maxlength="120"></label><label>Phone (optional)<input name="contact" value="${esc(a.contact || "")}" placeholder="+919…" maxlength="40"></label></div><div class="form-actions"><button class="primary">Save details</button>${a.status === "confirmed" ? `<button type="button" class="danger" data-action="release-block" data-id="${a.id}">Release slot</button>` : ""}</div></form>`,
      );
    } else if (action === "release-block") {
      if (!confirm("Release this slot so WhatsApp patients can book it again?")) return;
      await api(`/api/appointments/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "cancelled" }),
      });
      $("#modal").close();
      await load();
      toast("Slot released back to WhatsApp availability");
    } else if (["complete", "no-show", "cancel"].includes(action)) {
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
    } else if (action === "copy-voice-url") {
      try {
        await navigator.clipboard.writeText($("#voice-tool-url").textContent);
        toast("Voice tool endpoint copied");
      } catch {
        toast("Could not copy. Select the URL and copy it manually.", true);
      }
    } else if (action === "copy-voice-webhook") {
      try {
        await navigator.clipboard.writeText($("#voice-webhook-url").textContent);
        toast("Voice metering webhook URL copied");
      } catch {
        toast("Could not copy. Select the URL and copy it manually.", true);
      }
    } else if (action === "refresh-voice") {
      renderVoice();
    } else if (action === "view-transcript") {
      const call = (state.voice?.calls || []).find((c) => c.id === id);
      if (!call) return;
      modal(
        `Call transcript · ${call.caller_name}`,
        `<p class="hint" style="margin-bottom:12px">${esc(call.direction)} · ${esc(call.provider)} · ${call.billable_minutes} billable min (${formatDur(call.duration_seconds)}) · ${esc(stamp(call.created))}</p>${call.summary ? `<p style="margin-bottom:12px"><strong>Summary:</strong> ${esc(call.summary)}</p>` : ""}<div class="transcript-box">${esc(call.transcript || "No transcript recorded.")}</div>`,
      );
    } else if (action === "simulate-voice-call") {
      modal(
        "Simulate AI voice call (demo)",
        `<form id="simulate-voice-form"><div class="form-grid"><label>Caller name<input name="caller_name" value="Priya Menon" required maxlength="120"></label><label>Phone number<input name="contact" value="+919848055112" required></label><label>Direction<select name="direction"><option value="inbound" selected>Inbound receptionist</option><option value="outbound">Outbound reminder call</option></select></label><label>Outcome<select name="outcome"><option value="booking_requested" selected>Booking requested</option><option value="info_answered">Info answered</option><option value="reminder_confirmed">Reminder confirmed</option><option value="transferred">Transferred to staff</option><option value="missed">Missed</option></select></label><label>Call duration (seconds)<input name="duration_seconds" type="number" min="15" max="3600" value="165" required></label></div><div class="form-actions"><button class="primary">Log simulated call</button></div><p class="hint">Logs a demo call into your minute meter immediately. Disabled in production mode.</p></form>`,
      );
    } else if (action === "apply-preset") {
      const presetId = $("#preset-select")?.value;
      if (!presetId) return;
      button.disabled = true;
      try {
        const res = await post(`/api/clinics/${state.clinic.id}/apply-preset`, {
          preset_id: presetId,
        });
        state.clinic = res.clinic;
        await renderGrowthCatalog();
        const extra = res.skipped_due_to_plan_cap
          ? ` (${res.skipped_due_to_plan_cap} skipped by plan cap)`
          : "";
        toast(`Loaded ${res.label}: +${res.added_services} service(s)${extra}`);
      } finally {
        button.disabled = false;
      }
    } else if (action === "copilot-chip") {
      const q = button.dataset.question;
      if (!q) return;
      const input = $("#copilot-input");
      if (input) input.value = q;
      $("#copilot-form")?.requestSubmit();
    } else if (action === "copy-widget-snippet") {
      try {
        await navigator.clipboard.writeText($("#widget-embed-code").textContent);
        toast("1-line website widget embed snippet copied");
      } catch {
        toast("Could not copy. Select the snippet and copy it manually.", true);
      }
    } else if (action === "preview-widget") {
      const clinicId = state.clinic.id;
      if (window.JyutrixWidget) {
        await window.JyutrixWidget.open(clinicId);
      } else {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = `/widget.js`;
          s.onload = resolve;
          s.onerror = () => reject(new Error("Could not load widget.js"));
          document.head.appendChild(s);
        });
        if (window.JyutrixWidget) await window.JyutrixWidget.open(clinicId);
      }
    } else if (action === "refresh-queue") {
      await refreshQueue();
    } else if (action === "set-booking-mode") {
      const mode = button.dataset.mode;
      if (!mode) return;
      const saved = await api(`/api/clinics/${state.clinic.id}/queue-settings`, {
        method: "PUT",
        body: JSON.stringify({ booking_mode: mode }),
      });
      state.clinic = saved.clinic;
      state.queue = saved.board;
      paintQueue();
      toast(`Booking workflow switched to ${mode}`);
    } else if (action === "issue-token") {
      const sessionId = button.dataset.session || "morning";
      modal(
        "Issue queue token",
        `<form id="issue-token-form" data-session="${esc(sessionId)}"><div class="form-grid"><label>Patient name<input name="patient_name" required minlength="2" maxlength="120" placeholder="e.g. Suresh Reddy"></label><label>Phone (optional)<input name="contact" placeholder="+9198…" maxlength="20"></label><label>Source<select name="source"><option value="walk_in" selected>Walk-in desk</option><option value="phone">Phone call</option></select></label><label>Notes (optional)<input name="notes" placeholder="e.g. Follow-up check" maxlength="200"></label></div><div class="form-actions"><button class="primary">Issue token →</button></div></form>`,
      );
    } else if (action === "queue-next") {
      const sessionId = button.dataset.session || "morning";
      const res = await post("/api/queue/next", {
        clinic_id: state.clinic.id,
        session_id: sessionId,
        date: state.queue?.date || clinicTodayStr(),
      });
      state.queue = res.board;
      paintQueue();
      toast(
        res.serving
          ? `Now serving Token #${res.serving.token_number} (${res.serving.patient_name})`
          : "Queue session completed — no waiting tokens left",
      );
    } else if (action === "token-status") {
      const status = button.dataset.status;
      if (!status) return;
      await api(`/api/queue/tokens/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await refreshQueue();
      toast(`Token marked ${status}`);
    } else if (action === "refresh-recalls") {
      await refreshRecalls();
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
        vertical: d.get("vertical") || "dental",
        name: d.get("name"),
        doctor: d.get("doctor"),
        phone: d.get("phone"),
        address: d.get("address"),
        timezone: d.get("timezone"),
        fee: Number(d.get("fee")),
        duration: Number(d.get("duration")),
        open: d.get("open"),
        close: d.get("close"),
        google_review_url: String(d.get("google_review_url") || "").trim() || null,
        services: String(d.get("services") || "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      state.clinic = created;
      state.user.clinic_id = created.id;
      state.view = "setup";
      await launch();
      toast("Clinic workspace created with specialty services — complete Go-live setup next.");
    } else if (form.id === "copilot-form") {
      const question = String(new FormData(form).get("question") || "").trim();
      if (!question) return;
      state.copilotResult = await post("/api/copilot/query", {
        clinic_id: state.clinic.id,
        question,
      });
      paintCopilotResult();
    } else if (form.id === "voice-pack-form") {
      const d = new FormData(form);
      const saved = await api(`/api/clinics/${state.clinic.id}/voice-pack`, {
        method: "PUT",
        body: JSON.stringify({
          voice_pack: d.get("voice_pack"),
          voice_alert_threshold_pct: Number(d.get("voice_alert_threshold_pct")),
        }),
      });
      state.clinic = saved.clinic;
      await load();
      toast(`Voice pack saved: ${saved.usage.pack_label}`);
    } else if (form.id === "simulate-voice-form") {
      const d = new FormData(form);
      const logged = await post("/api/voice/simulate", {
        clinic_id: state.clinic.id,
        caller_name: d.get("caller_name"),
        contact: d.get("contact"),
        direction: d.get("direction"),
        outcome: d.get("outcome"),
        duration_seconds: Number(d.get("duration_seconds")),
      });
      $("#modal").close();
      await load();
      toast(`Logged ${logged.call.billable_minutes} min call (${logged.usage.minutes_used}/${logged.usage.minutes_included} min used)`);
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
    } else if (form.id === "edit-patient-form") {
      const d = new FormData(form);
      await api(`/api/appointments/${form.dataset.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: d.get("name"),
          contact: d.get("contact"),
        }),
      });
      $("#modal").close();
      await load();
      toast("Patient details saved");
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
    } else if (form.id === "issue-token-form") {
      const d = new FormData(form);
      const issued = await post("/api/queue/tokens", {
        clinic_id: state.clinic.id,
        date: state.queue?.date || clinicTodayStr(),
        session_id: form.dataset.session || "morning",
        patient_name: d.get("patient_name"),
        contact: d.get("contact"),
        source: d.get("source"),
        notes: d.get("notes"),
      });
      $("#modal").close();
      await refreshQueue();
      toast(`Issued Token #${issued.token.token_number} (Est. wait ~${issued.estimated_wait_minutes}m)`);
    } else if (form.id === "recall-campaign-form") {
      const d = new FormData(form);
      const res = await post("/api/recalls/campaigns", {
        clinic_id: state.clinic.id,
        kind: d.get("kind"),
        name: d.get("name"),
        template_name: d.get("template_name"),
        custom_message: d.get("custom_message"),
        days: d.get("days") !== "" ? Number(d.get("days")) : null,
      });
      await refreshRecalls();
      toast(
        `Recall launched: ${res.campaign.sent_count} nudged, ${res.campaign.skipped_opted_out} opted-out/no-consent skipped`,
      );
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
    if (event.target.id === "timeline-day") {
      state.timelineDay = event.target.value;
      await refreshTimeline();
    }
    if (event.target.id === "queue-date") {
      state.queueDate = event.target.value;
      await refreshQueue();
    }
    if (event.target.id === "recall-kind") {
      state.recallKind = event.target.value;
      state.recallDays = "";
      await refreshRecalls();
    }
    if (event.target.id === "recall-days") {
      state.recallDays = event.target.value;
      await refreshRecalls();
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
