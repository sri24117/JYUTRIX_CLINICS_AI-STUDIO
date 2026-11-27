(function () {
  "use strict";

  var scriptEl = document.currentScript;
  var scriptSrc = (scriptEl && scriptEl.src) || window.location.origin + "/widget.js";
  var origin;
  try {
    origin = new URL(scriptSrc, window.location.href).origin;
  } catch (e) {
    origin = window.location.origin;
  }

  var initialClinicId = scriptEl && scriptEl.getAttribute("data-clinic-id");

  var STYLES = [
    ":host { all: initial; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #16232a; }",
    "* { box-sizing: border-box; }",
    ".jw-launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: inline-flex; align-items: center; gap: 8px; background: #136859; color: #ffffff; border: 0; border-radius: 999px; padding: 12px 18px; font-size: 14px; font-weight: 600; cursor: pointer; box-shadow: 0 10px 28px rgba(19, 104, 89, 0.28); transition: transform 0.12s ease, background 0.12s ease; }",
    ".jw-launcher:hover { background: #0e5347; transform: translateY(-1px); }",
    ".jw-dot { width: 8px; height: 8px; border-radius: 50%; background: #7ae2be; display: inline-block; }",
    ".jw-panel { position: fixed; right: 20px; bottom: 76px; z-index: 2147483000; width: 356px; max-width: calc(100vw - 24px); max-height: min(600px, calc(100vh - 96px)); background: #ffffff; border: 1px solid #d7e2df; border-radius: 16px; box-shadow: 0 18px 46px rgba(16, 39, 32, 0.2); display: flex; flex-direction: column; overflow: hidden; }",
    ".jw-panel[hidden] { display: none; }",
    ".jw-head { background: #136859; color: #ffffff; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }",
    ".jw-head-title { font-size: 15px; font-weight: 650; line-height: 1.25; }",
    ".jw-head-sub { font-size: 11px; opacity: 0.88; margin-top: 2px; }",
    ".jw-close { background: rgba(255,255,255,0.16); color: #ffffff; border: 0; width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font-size: 14px; }",
    ".jw-tabs { display: flex; border-bottom: 1px solid #e0e8e8; background: #f5f8f7; }",
    ".jw-tab { flex: 1; border: 0; background: transparent; padding: 10px 8px; font-size: 12px; font-weight: 600; color: #5b6d74; cursor: pointer; border-bottom: 2px solid transparent; }",
    ".jw-tab.active { color: #136859; border-bottom-color: #136859; background: #ffffff; }",
    ".jw-body { padding: 14px; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 10px; background: #fafcfb; }",
    ".jw-msg { max-width: 88%; padding: 9px 12px; border-radius: 11px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }",
    ".jw-msg.bot { background: #ffffff; border: 1px solid #e0e8e8; color: #16232a; align-self: flex-start; }",
    ".jw-msg.user { background: #e3f2ec; color: #0e4a3f; align-self: flex-end; }",
    ".jw-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }",
    ".jw-chip { background: #ffffff; border: 1px solid #c9dcd5; color: #136859; border-radius: 999px; padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; }",
    ".jw-chip:hover { background: #e3f2ec; }",
    ".jw-ask-form { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid #e0e8e8; background: #ffffff; }",
    ".jw-input { flex: 1; padding: 9px 10px; border: 1px solid #d7e2df; border-radius: 8px; font-size: 13px; font-family: inherit; color: #16232a; background: #ffffff; }",
    ".jw-btn { background: #136859; color: #ffffff; border: 0; border-radius: 8px; padding: 9px 13px; font-size: 12px; font-weight: 600; cursor: pointer; }",
    ".jw-btn:disabled { opacity: 0.55; cursor: wait; }",
    ".jw-lead-form { display: flex; flex-direction: column; gap: 10px; }",
    ".jw-label { font-size: 11px; font-weight: 600; color: #54666a; display: flex; flex-direction: column; gap: 4px; }",
    ".jw-textarea { padding: 9px 10px; border: 1px solid #d7e2df; border-radius: 8px; font-size: 13px; font-family: inherit; min-height: 68px; resize: vertical; color: #16232a; }",
    ".jw-status { font-size: 12px; padding: 9px 11px; border-radius: 8px; background: #e3f2ec; color: #136859; }",
    ".jw-status.error { background: #fcebed; color: #af3948; }",
    ".jw-footer { padding: 10px 12px; border-top: 1px solid #e0e8e8; background: #f5f8f7; display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
    ".jw-wa { display: inline-flex; align-items: center; justify-content: center; gap: 6px; background: #1f8a5b; color: #ffffff; text-decoration: none; font-size: 12px; font-weight: 600; padding: 7px 11px; border-radius: 8px; }",
    ".jw-wa:hover { background: #166e47; }",
    ".jw-credit { font-size: 10px; color: #7a8a90; }",
  ].join("\n");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function safeWhatsAppUrl(rawUrl) {
    if (typeof rawUrl !== "string") return "";
    if (rawUrl.indexOf("https://wa.me/") === 0) return rawUrl;
    return "";
  }

  var state = {
    host: null,
    shadow: null,
    clinicId: null,
    info: null,
    open: false,
    tab: "chat",
    messages: [],
  };

  function ensureHost() {
    if (state.host && document.body.contains(state.host)) return;
    var host = document.createElement("div");
    host.id = "jyutrix-widget-host";
    document.body.appendChild(host);
    var shadow = host.attachShadow({ mode: "open" });
    var styleTag = document.createElement("style");
    styleTag.textContent = STYLES;
    shadow.appendChild(styleTag);

    var launcher = el("button", "jw-launcher");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open clinic chat");
    launcher.appendChild(el("span", "jw-dot"));
    var launcherText = el("span", "jw-launcher-label", "Chat with clinic");
    launcher.appendChild(launcherText);

    var panel = el("section", "jw-panel");
    panel.hidden = true;

    shadow.appendChild(panel);
    shadow.appendChild(launcher);

    launcher.addEventListener("click", function () {
      state.open = !state.open;
      panel.hidden = !state.open;
      if (state.open) renderPanel();
    });

    state.host = host;
    state.shadow = shadow;
    state.launcher = launcher;
    state.launcherText = launcherText;
    state.panel = panel;
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function appendMessage(role, text) {
    state.messages.push({ role: role, text: String(text || "") });
  }

  async function askClinic(question) {
    var q = String(question || "").trim();
    if (!q || !state.clinicId) return;
    appendMessage("user", q);
    renderPanel();
    try {
      var res = await fetch(origin + "/api/public/widget/" + encodeURIComponent(state.clinicId) + "/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      var data = await res.json();
      if (!res.ok) {
        appendMessage("bot", data.detail || "Sorry, I could not answer right now.");
      } else {
        appendMessage("bot", data.reply || "Please call the clinic for help.");
      }
    } catch (e) {
      appendMessage("bot", "Could not reach the clinic right now. Please try WhatsApp below.");
    }
    renderPanel();
  }

  function renderPanel() {
    var panel = state.panel;
    if (!panel) return;
    clearChildren(panel);

    var info = state.info;

    // Header
    var head = el("div", "jw-head");
    var headLeft = el("div");
    headLeft.appendChild(el("div", "jw-head-title", info ? info.name : "Clinic Assistant"));
    headLeft.appendChild(
      el(
        "div",
        "jw-head-sub",
        info ? info.doctor + " · Fee ₹" + info.fee : "Loading clinic details…",
      ),
    );
    var closeBtn = el("button", "jw-close", "✕");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.addEventListener("click", function () {
      state.open = false;
      panel.hidden = true;
    });
    head.appendChild(headLeft);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    // Tabs
    var tabs = el("div", "jw-tabs");
    var chatTab = el("button", "jw-tab" + (state.tab === "chat" ? " active" : ""), "Ask a question");
    chatTab.type = "button";
    chatTab.addEventListener("click", function () {
      state.tab = "chat";
      renderPanel();
    });
    var leadTab = el("button", "jw-tab" + (state.tab === "lead" ? " active" : ""), "Request callback");
    leadTab.type = "button";
    leadTab.addEventListener("click", function () {
      state.tab = "lead";
      renderPanel();
    });
    tabs.appendChild(chatTab);
    tabs.appendChild(leadTab);
    panel.appendChild(tabs);

    // Body
    var body = el("div", "jw-body");
    if (!info) {
      body.appendChild(el("div", "jw-msg bot", "Loading clinic information…"));
      panel.appendChild(body);
      return;
    }

    if (state.tab === "chat") {
      state.messages.forEach(function (m) {
        body.appendChild(el("div", "jw-msg " + m.role, m.text));
      });

      var chips = el("div", "jw-chips");
      var quickQuestions = ["Consultation fee", "Clinic timings", "Address", "Services"];
      (info.faqs || []).slice(0, 3).forEach(function (f) {
        if (f && f.question) quickQuestions.push(f.question);
      });
      quickQuestions.forEach(function (qText) {
        var chip = el("button", "jw-chip", qText);
        chip.type = "button";
        chip.addEventListener("click", function () {
          askClinic(qText);
        });
        chips.appendChild(chip);
      });
      body.appendChild(chips);
      panel.appendChild(body);

      var askForm = el("form", "jw-ask-form");
      var input = el("input", "jw-input");
      input.type = "text";
      input.placeholder = "Ask about fees, timings, services…";
      input.maxLength = 400;
      input.required = true;
      var sendBtn = el("button", "jw-btn", "Send");
      sendBtn.type = "submit";
      askForm.appendChild(input);
      askForm.appendChild(sendBtn);
      askForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var val = input.value.trim();
        if (!val) return;
        input.value = "";
        askClinic(val);
      });
      panel.appendChild(askForm);
    } else {
      var intro = el(
        "div",
        "jw-msg bot",
        "Leave your contact details and our reception desk will call or WhatsApp you to confirm a slot.",
      );
      body.appendChild(intro);

      var leadForm = el("form", "jw-lead-form");

      var nameLbl = el("label", "jw-label", "Your name");
      var nameInput = el("input", "jw-input");
      nameInput.name = "name";
      nameInput.required = true;
      nameInput.maxLength = 120;
      nameInput.placeholder = "e.g. Ananya Sharma";
      nameLbl.appendChild(nameInput);

      var phoneLbl = el("label", "jw-label", "Phone / WhatsApp number");
      var phoneInput = el("input", "jw-input");
      phoneInput.name = "contact";
      phoneInput.required = true;
      phoneInput.maxLength = 30;
      phoneInput.placeholder = "+91 98765 43210";
      phoneLbl.appendChild(phoneInput);

      var svcLbl = el("label", "jw-label", "What do you need help with?");
      var svcInput = el("textarea", "jw-textarea");
      svcInput.name = "service_interest";
      svcInput.maxLength = 300;
      svcInput.placeholder = "e.g. Dental checkup tomorrow evening";
      svcLbl.appendChild(svcInput);

      var statusBox = el("div", "jw-status");
      statusBox.hidden = true;

      var submitBtn = el("button", "jw-btn", "Request callback");
      submitBtn.type = "submit";

      leadForm.appendChild(nameLbl);
      leadForm.appendChild(phoneLbl);
      leadForm.appendChild(svcLbl);
      leadForm.appendChild(statusBox);
      leadForm.appendChild(submitBtn);

      leadForm.addEventListener("submit", async function (ev) {
        ev.preventDefault();
        submitBtn.disabled = true;
        statusBox.hidden = true;
        try {
          var res = await fetch(
            origin + "/api/public/widget/" + encodeURIComponent(state.clinicId) + "/lead",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: nameInput.value.trim(),
                contact: phoneInput.value.trim(),
                service_interest: svcInput.value.trim(),
              }),
            },
          );
          var data = await res.json();
          if (!res.ok) {
            statusBox.className = "jw-status error";
            statusBox.textContent = data.detail || "Could not submit your request.";
            statusBox.hidden = false;
          } else {
            statusBox.className = "jw-status";
            statusBox.textContent =
              "Thanks! Reception received your enquiry (#" + data.enquiry_id + ") and will reach out shortly.";
            statusBox.hidden = false;
            leadForm.reset();
          }
        } catch (e) {
          statusBox.className = "jw-status error";
          statusBox.textContent = "Network error. Please try WhatsApp below.";
          statusBox.hidden = false;
        } finally {
          submitBtn.disabled = false;
        }
      });

      body.appendChild(leadForm);
      panel.appendChild(body);
    }

    // Footer with WhatsApp handoff
    var footer = el("div", "jw-footer");
    var waHref = safeWhatsAppUrl(info.whatsapp_url);
    if (waHref) {
      var waLink = el("a", "jw-wa", "Book on WhatsApp →");
      waLink.href = waHref;
      waLink.target = "_blank";
      waLink.rel = "noopener noreferrer";
      footer.appendChild(waLink);
    }
    footer.appendChild(el("span", "jw-credit", "Powered by Jyutrix"));
    panel.appendChild(footer);

    body.scrollTop = body.scrollHeight;
  }

  async function mount(clinicId, openImmediately) {
    if (!clinicId) return;
    ensureHost();
    if (String(state.clinicId) !== String(clinicId) || !state.info) {
      state.clinicId = String(clinicId);
      state.info = null;
      state.messages = [];
      state.tab = "chat";
      try {
        var res = await fetch(origin + "/api/public/widget/" + encodeURIComponent(state.clinicId));
        if (!res.ok) {
          if (state.launcher) state.launcher.hidden = true;
          return;
        }
        var info = await res.json();
        state.info = info;
        if (state.launcher) state.launcher.hidden = false;
        if (state.launcherText) state.launcherText.textContent = "Chat · " + info.name;
        appendMessage(
          "bot",
          info.widget_greeting ||
            "Hi! Ask about " + info.name + "'s fees, timings, or services—or book on WhatsApp.",
        );
      } catch (e) {
        return;
      }
    }
    if (openImmediately) {
      state.open = true;
      state.panel.hidden = false;
    }
    if (state.open) renderPanel();
  }

  window.JyutrixWidget = {
    open: function (clinicId) {
      return mount(clinicId || initialClinicId, true);
    },
    close: function () {
      state.open = false;
      if (state.panel) state.panel.hidden = true;
    },
  };

  if (initialClinicId) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () {
        mount(initialClinicId, false);
      });
    } else {
      mount(initialClinicId, false);
    }
  }
})();
