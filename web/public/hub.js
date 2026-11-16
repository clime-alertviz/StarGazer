import { appShell, esc, icon } from "./shell.js";
import { initFx, burstFrom, celebrate, meteorShower } from "./fx.js";
import { skyIllustration, passport, constellation } from "./graphics.js";
import { autocomplete } from "./autocomplete.js";
import { locate, locationContext } from "./location.js";
import { mountProfile } from "./profile-editor.js";
import { openJoin } from "./join-panel.js";
import {
  defaultPlanningWindow,
  planningWindowProblem,
} from "./planning-window.js";

const $ = (s) => document.querySelector(s),
  app = $("#app"),
  modal = $("#modal-root");
let bootstrap,
  state,
  offers = [],
  otherDates = false,
  pausedPlanning = null,
  activePlan = null,
  discoveryTimer,
  outing,
  view = new URLSearchParams(location.search).get("view") || "explore",
  sequence = 0,
  wizard = null,
  replyTo = null,
  skyTarget = "Saturn",
  offerTimer,
  pointCleanups = [];
const symbols = { saturn: "♄", moon: "☾", star: "✦", comet: "☄" },
  closed = ["cancelled", "completed", "not_formed"];
const date = (value, tz = state?.user.preferences?.timezone) =>
  value
    ? new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        ...(tz ? { timeZone: tz } : {}),
      }).format(new Date(value))
    : "—";
const local = (value) => {
  const d = new Date(value);
  return new Date(d - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
const button = (label, action, extra = "", primary = false) =>
  `<button type="button" class="${primary ? "primary" : "secondary"}" data-action="${action}" ${extra}>${label}</button>`;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 6000);
}
async function http(path, data) {
  const r = await fetch(path, {
    ...(data
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-stargazer-csrf": bootstrap?.csrf || "",
          },
          body: JSON.stringify(data),
        }
      : {}),
  });
  const value = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(value.error || "Request failed."), {
      status: r.status,
    });
  return value;
}
async function call(name, args = {}, options = {}) {
  const r = await fetch("/mcp", {
    signal: options.signal,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      "x-stargazer-csrf": bootstrap.csrf,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++sequence,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const value = await r.json();
  if (!r.ok || value.error)
    throw new Error(
      value.error?.message || value.error || "The request failed.",
    );
  const text = value.result?.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (value.result?.isError) throw new Error(text);
  return JSON.parse(text || "null");
}
function shell(content, active = view, detail = "") {
  document.documentElement.style.setProperty(
    "--clock",
    `-${(performance.now() / 1000).toFixed(2)}s`,
  );
  app.innerHTML = appShell({
    content,
    active,
    detail,
    profileCount: state?.circle.length || 0,
    navigation: Boolean(bootstrap?.user),
    footerTools: bootstrap?.local
      ? '<details class="local-tools"><summary>Local development</summary><a href="/outbox">Open local outbox ↗</a></details>'
      : "",
    topActions: bootstrap?.user
      ? `<span class="connection-pill"><i></i> ${esc(state?.user.preferences?.name || bootstrap.user.email.split("@")[0])}</span>${button(icon("settings"), "settings", 'aria-label="Settings"')}`
      : `${active !== "explore" ? '<a href="/?view=explore" data-action="view" data-view="explore" class="public-browse">Browse outings</a>' : ""}${active !== "signin" ? button("Sign in", "signin") : ""}`,
    sidebarBottom: bootstrap?.user
      ? `<div class="sidebar-stars" aria-hidden="true">${constellation}</div>`
      : "",
    footerHint: true,
  });
  document
    .querySelectorAll(".utility-nav,.mobile-tools")
    .forEach(
      (n) =>
        (n.innerHTML = bootstrap?.local
          ? '<a href="/outbox">Local outbox ↗</a>'
          : ""),
    );
}
function card(o, compact = false) {
  const visual =
    o.target === "stargazing" ? "stars" : o.target.toLowerCase();
  return `<article class="night-card glow ${compact ? "compact" : "tilt"}"><div class="night-art ${visual}" aria-hidden="true">${skyIllustration(o.target)}</div><div class="night-body"><div class="card-meta"><span>${esc(o.target === "stargazing" ? "UNDER THE STARS" : o.target.toUpperCase())}</span><span class="status-chip">${o.remaining} ${o.remaining === 1 ? "place" : "places"}${o.driverPlaces ? " + driver" : ""}</span></div><h3>${esc(o.title)}</h3><p>${esc(date(o.start, o.timezone))}</p><p class="muted">${icon("location", 14)} ${esc(o.site.name)}</p>${o.agentReason ? `<p class="mint">${esc(o.agentReason)}</p>` : ""}${o.matchReasons?.length ? `<small class="mint">${o.matchReasons.map(esc).join(" · ")}</small>` : ""}<small class="muted">Journey checked when you join.</small><div class="card-bottom"><div class="avatar-stack">${(
    o.people || []
  )
    .slice(0, 4)
    .map((p) => `<span title="${esc(p.name)}">${symbols[p.avatar]}</span>`)
    .join(
      "",
    )}<small>${o.going ?? o.people.filter((p) => p.response === "accepted").length} going</small></div>${button(compact ? "Take a look →" : "Explore this night →", "outing", `data-id="${o.id}"`)}</div></div></article>`;
}
async function refresh() {
  state = await call("get_state");
}
async function navigate(next, push = true) {
  wizard = null;
  modal.replaceChildren();
  view = next;
  outing = null;
  if (push) history.pushState({}, "", `/?view=${next}`);
  window.scrollTo(0, 0);
  await render();
}
async function render() {
  if (location.pathname === "/outbox") return outbox();
  if (location.pathname === "/signin" && location.hash) return signin(true);
  const publicMatch = location.pathname.match(/^\/outing\/([^/]+)$/);
  if (!bootstrap.user) {
    if (publicMatch) return showPublicOuting(publicMatch[1], false);
    if (
      location.pathname === "/signin" ||
      location.pathname === "/settings" ||
      ["circle", "outings", "settings", "profile", "plan"].includes(view)
    )
      return signin(false);
    offers = await http("/api/public-outings");
    return discover();
  }
  await refresh();
  const match = location.pathname.match(/^\/outing\/([^/]+)$/);
  if (match) return showOuting(match[1], false);
  if (view === "circle") return circle();
  if (view === "outings") return myOutings();
  if (view === "settings") return settings();
  if (view === "profile") return profilePage();
  offers = await call("find_outings");
  otherDates = !offers.length;
  if (otherDates) offers = await call("find_outings", { anyDate: true });
  discover();
  if (view === "plan") openWizard();
}
function matchingNote(items) {
  const matching = items.find((o) => o.matching)?.matching;
  if (!matching) return "";
  const message =
    matching.status === "pending"
      ? "Codex is reviewing your interests and comparing these evenings…"
      : matching.status === "ready"
        ? "Ordered by your Codex matching agent. Your journey is checked when you join."
        : `Codex matching is unavailable: ${matching.error} These suggestions use basic filters only.`;
  return `<p class="fineprint" role="status">${esc(message)}</p>`;
}
function pollDiscovery() {
  clearTimeout(discoveryTimer);
  if (wizard || !offers.some((o) => o.matching?.status === "pending"))
    return;
  discoveryTimer = setTimeout(async () => {
    if (wizard || view !== "explore" || location.pathname !== "/") return;
    try {
      const updated = await call("find_outings", {
        anyDate: otherDates,
      });
      const changed = JSON.stringify(updated) !== JSON.stringify(offers);
      offers = updated;
      if (!wizard && view === "explore") {
        if (changed) discover();
        else pollDiscovery();
      }
    } catch (error) {
      toast(error.message);
    }
  }, 2000);
}
function discover() {
  shell(
    `<section class="hub-hero"><div class="hero-copy"><div class="eyebrow">LITTLE PLANS, BIG SKIES</div><h1>Find your kind<br>of <em>night.</em></h1><p>A good sky. A place to meet.<br>People to share the wonder with.</p><div class="hero-actions">${button("Plan your next adventure →", "preferences", "", true)}<span>Join a night below, or make one of your own.</span></div></div>${skyIllustration(skyTarget, true)}</section><section class="section-head"><div><div class="eyebrow">THERE’S ROOM UNDER THE STARS</div><h2>${otherDates && offers.length ? "Other nights to explore." : "Nights you could join."}</h2>${otherDates && offers.length ? '<p class="muted">These evenings are outside your saved availability. Take a look if your plans are flexible.</p>' : ""}</div><span class="muted">${offers.length} open ${offers.length === 1 ? "invitation" : "invitations"}</span></section>${matchingNote(offers)}<div class="night-grid">${offers.map((o) => card(o)).join("") || `<div class="empty-card"><h3>A little space for a new adventure.</h3><p>Create an open outing. Friends can join your circle along the way.</p>${button("Plan your next adventure →", "preferences", "", true)}</div>`}</div><p class="fineprint">${bootstrap.user ? "Suggestions use the preferences you have shared. Joining checks availability, walking, seats and the journey home." : "Explore freely. Sign in to join a night or organize your own; we’ll help check availability and the journey there."}</p>`,
    "explore",
  );
  pollDiscovery();
}
function requestSignin(returnTo = location.pathname + location.search) {
  if (location.pathname === "/signin") returnTo = "/";
  history.pushState(
    {},
    "",
    `/signin?returnTo=${encodeURIComponent(returnTo)}`,
  );
  window.scrollTo(0, 0);
  signin(false);
}
function signin(confirm) {
  shell(
    `<section class="welcome"><div class="welcome-art">${skyIllustration("Saturn")}</div><div class="eyebrow">YOUR NEXT EVENING STARTS HERE</div><h1>A little less planning.<br><em>A little more wonder.</em></h1><p>Find the night, the place and the company.</p><section class="panel signin-panel">${confirm ? `<h2>You’re one click away.</h2><p>Continue to sign in. Your link is only used when you click.</p>${button("Continue to Star Gazer →", "confirm-signin", "", true)}` : `<h2>Come on in.</h2><form id="signin-form"><label>Your email<input type="email" name="email" autocomplete="email" required placeholder="you@example.com"></label><button class="primary">Email me a sign-in link →</button></form><small>No password to remember. New here? Your first sign-in creates your account.</small>${bootstrap?.local ? '<p><a href="/outbox">Open local outbox ↗</a></p>' : ""}`}</section></section>`,
    "signin",
  );
}
async function showPublicOuting(id, push = true) {
  if (push) {
    history.pushState({}, "", `/outing/${id}`);
    window.scrollTo(0, 0);
  }
  let o;
  try {
    o = await http(`/api/public-outings/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error.status === 404) return signin(false);
    throw error;
  }
  shell(
    `<section class="outing-heading"><div><div class="eyebrow">AN OPEN INVITATION</div><h1>${esc(o.title)}</h1><div class="outing-subtitle"><span class="status-chip ${o.status}">${esc(o.statusLabel)}</span><span>${esc(date(o.start, o.timezone))} – ${esc(new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: o.timezone }).format(new Date(o.end)))}</span></div><p>${esc(o.site.name)} · ${esc(o.timezone)}</p></div><div class="outing-illustration" aria-hidden="true">${skyIllustration(o.target)}</div></section><div class="outing-columns"><section class="panel"><h2>${o.remaining || o.driverPlaces ? "There’s room for you." : "A full constellation."}</h2><p>${o.going} going · ${o.remaining} ${o.remaining === 1 ? "place remains" : "places remain"}.${o.driverPlaces ? " One additional place is reserved for someone offering a lift." : ""}</p><p>${o.remaining || o.driverPlaces ? "Sign in to share your evening preferences and check whether the journey works for you." : "All places are currently taken. Browse another open night."}</p>${o.remaining || o.driverPlaces ? button("Sign in to join →", "signin", "", true) : '<a class="secondary" href="/?view=explore" data-action="view" data-view="explore">Browse other outings →</a>'}</section><section class="panel"><h2>A place to meet.</h2><h3>${esc(o.site.name)}</h3><p>${esc(o.site.accessNote)}</p><small>${o.site.walkMinutes} minutes walking from the meeting point, each way.</small></section></div>${skyReport(o)}`,
    "explore",
  );
}
async function outbox() {
  const messages = await http("/api/local-outbox");
  shell(
    `<section class="section-head"><div><div class="eyebrow">LOCAL DELIVERY</div><h1>Your outbox.</h1><p>Sign-in links and messages from this local instance.</p></div>${button("Refresh ↻", "outbox")}</section><div class="message-list">${messages.map((m) => `<article class="panel"><div class="card-meta"><span>${esc(m.to)}</span><span class="status-chip">${esc(m.delivery.replace("_", " "))}</span></div><h3>${esc(m.subject)}</h3><p>${esc(m.text)}</p>${m.error ? `<p class="error">${esc(m.error)}</p>` : ""}${m.link ? `<a class="secondary" href="${esc(m.link)}">${m.subject.includes("sign-in") ? "Open sign-in link" : "Open in Star Gazer"} →</a>` : ""}<small>${esc(date(m.createdAt))}</small></article>`).join("") || "<p>No messages yet.</p>"}</div>`,
    "outbox",
  );
}
function circle() {
  shell(
    `<section class="section-head"><div><div class="eyebrow">GOOD COMPANY, OVER TIME</div><h1>Your circle.</h1><p>Keep in touch with the people you like watching the sky with.</p></div></section><section class="panel invite-friend"><h2>There’s room for a friend.</h2><form id="circle-form"><label>Email address<input name="email" type="email" placeholder="friend@example.com" required></label><button class="primary">Invite to my circle →</button></form><small>They choose whether to join. Outing invitations remain a separate choice.</small></section>${state.circleInvitations.length ? `<section class="panel"><h2>A little hello.</h2>${state.circleInvitations.map((c) => `<div class="person-row"><span class="avatar">${symbols[c.person.avatar]}</span><div><strong>${esc(c.person.name)}</strong><small>${c.incoming ? "Invited you to their circle" : "Invitation sent"}</small></div>${c.incoming ? `${button("Accept", "circle-respond", `data-id="${c.id}" data-accept="true"`, true)}${button("Decline", "circle-respond", `data-id="${c.id}" data-accept="false"`)}` : ""}</div>`).join("")}</section>` : ""}<div class="people-grid">${state.circle.map((p) => `<article class="panel person-card"><span class="large-avatar ${p.avatar}">${symbols[p.avatar]}</span><h2>${esc(p.name)}</h2><p>${p.experience === "experienced" ? "Knows the sky" : "Curious beginner"}</p><small>${p.equipment.map(esc).join(" · ") || "Brings curiosity"}</small></article>`).join("") || '<section class="empty-card"><h2>Every circle starts with a hello.</h2><p>Join an open outing, then invite someone from its participant card. Or invite a friend by email above.</p></section>'}</div>`,
    "circle",
  );
}
function myOutings() {
  shell(
    `<section class="section-head"><div><div class="eyebrow">EVENINGS WORTH MAKING TIME FOR</div><h1>Your outings.</h1></div>${button("Plan your next adventure →", "preferences", "", true)}</section><div class="night-grid">${state.outings.map((o) => `<div><span class="outing-label">${esc(o.statusLabel)} · ${o.organizer ? "You organize" : "You’re invited"}</span>${card(o)}</div>`).join("") || '<div class="empty-card"><h2>Your first night is waiting.</h2><p>Explore an open outing or create your own.</p></div>'}</div>`,
    "outings",
  );
}
function settings() {
  const p = state.providers;
  shell(
    `<section class="section-head"><div><div class="eyebrow">CONNECTED, YOUR WAY</div><h1>Make yourself at home.</h1></div></section><div class="settings-grid"><section class="panel"><h2>Your account</h2><p>${esc(state.user.email)}</p>${button("Profile & preferences", "edit-profile")}${button("Sign out", "logout")}<p class="fineprint">Outing notifications use your selected channel: email or Calendar. Comments, sign-in links and personal ride-response alerts use email.</p></section><section class="panel"><h2>Google Calendar & Gmail</h2><p>${p.googleConnected ? "Your Google account is connected." : "Connect the account you organize from to send Calendar invitations and emails."}</p>${button(p.googleConnected ? "Reconnect Google" : "Connect Google →", "connect-google", "", true)}${p.googleConnected ? button("Disconnect", "disconnect-google") : ""}<details><summary>Provider setup</summary><p>Register a Google OAuth web application. Enable Calendar API and Gmail API, add your test users, and configure these server environment variables:</p><pre>GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
STAR_GAZER_BASE_URL (when hosted)</pre><p>Authorized redirect URI:</p><code>${esc(p.callback)}</code><p>For sign-in email delivery, set SMTP_URL and MAIL_FROM. Until configured, use the local outbox on this computer. Google access is authorized separately from Codex.</p><p>Restart the server after changing environment variables.</p></details></section><section class="panel"><h2>StarGazer in Codex</h2><p>Use the same account, circle and outings through the StarGazer skill and MCP package.</p>${button("Create MCP access token", "mcp-token")} ${button("Revoke token", "revoke-token")}<div id="token-result"></div><small>Tokens expire after 90 days. Creating a new one revokes the previous token.</small></section><section class="panel"><h2>Try a real response.</h2><p>Send a connection test to a second account you control, then accept or decline there.</p><form id="connection-test-form">${field("Guest email", "guestEmail", "email", "", "required")}${field("Test time", "start", "datetime-local", local(Date.now() + 86400000), "required")}<label>Invitation channel<select name="channel"><option value="calendar">Google Calendar</option><option value="email">Email</option></select></label><button class="primary">Send test invitation →</button></form></section><section class="panel"><h2>Delivery</h2><p>System email: <strong>${esc(p.email.replace("_", " "))}</strong></p>${bootstrap.local ? '<a class="secondary" href="/outbox">Open local outbox →</a>' : ""}<p>Calendar invitations are handled by the connected organizer’s Google account. Guests can respond in Calendar or on the outing page.</p></section></div>`,
    "settings",
  );
}
function profilePage() {
  shell(
    `<section class="section-head"><div><div class="eyebrow">REMEMBERED, FOR NEXT TIME</div><h1>Profile & preferences.</h1><p>Update your defaults whenever you like. You confirm this evening’s arrangements when you plan or join.</p></div>${button("Back to settings", "settings")}</section><div id="profile-editor"></div>`,
    "settings",
  );
  mountProfile($("#profile-editor"), {
    profile: state.user.preferences,
    email: state.user.email,
    call,
    onSaved: async () => {
      await refresh();
      toast("Your preferences are saved.");
      profilePage();
    },
  });
}
function defaults() {
  const now = new Date(Date.now() + 86400000),
    date = local(now).slice(0, 10);
  return {
    name: state.user.email.split("@")[0],
    avatar: "star",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    interests: ["Open to anything"],
    interestNote: "",
    experience: "beginner",
    happyToTeach: false,
    equipment: [],
    shareEquipment: false,
    channel: "email",
    origin: null,
    slots: [{ date, from: "17:00", until: "02:00", weekly: false }],
    travel: [],
    maxTravelMinutes: 60,
    maxWalkMinutes: 20,
    preference: "balanced",
    car: {
      available: false,
      offerRides: false,
      passengerSeats: 2,
      maxDetourMinutes: 20,
      pickupPoints: [],
    },
  };
}
const titles = [
  "A little about you.",
  "Make room for the night.",
  "Your kind of wonder.",
  "What you bring.",
  "The journey there.",
  "Find your kind of evening.",
];
const subtitles = [
  "Every great night starts with a hello.",
  "One evening, a few options, or a standing invitation.",
  "Interests help us find company you’ll enjoy.",
  "Good company makes room for sharing.",
  "A good plan gets everyone there. And home again.",
  "Join a night that fits, or organize one of your own.",
];
function openWizard() {
  clearTimeout(discoveryTimer);
  if (pausedPlanning?.outingId) {
    const id = pausedPlanning.outingId;
    pausedPlanning = null;
    return showOuting(id);
  }
  if (pausedPlanning?.form) return organizerForm(pausedPlanning.form);
  if (pausedPlanning?.wizard) {
    wizard = structuredClone(pausedPlanning.wizard);
    renderWizard();
    updateOffers();
    return;
  }
  wizard = {
    step: 0,
    data: {
      ...defaults(),
      ...structuredClone(state.user.preferences || {}),
    },
    offers: [],
    returnTo: location.pathname,
  };
  wizard.data.car = {
    ...defaults().car,
    ...wizard.data.car,
    available: false,
    offerRides: false,
  };
  // Older imports used this generic label as an address. Ask for an actual
  // place instead of pre-filling or searching the placeholder text.
  if (
    wizard.data.origin?.name?.trim().toLowerCase() ===
    "public meeting point"
  )
    delete wizard.data.origin;
  if (!wizard.data.slots?.length) wizard.data.slots = defaults().slots;
  if (!wizard.data.travel?.length) wizard.data.travel = defaults().travel;
  renderWizard();
  updateOffers();
}
function field(label, name, type, value, attrs = "") {
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value ?? "")}" ${attrs}></label>`;
}
function toggle(label, name, value, checked, detail = "") {
  const glyphs = {
    Planets: "♄",
    Stargazing: "✦",
    Photography: "◉",
    Learning: "✧",
    "Social evenings": "☾",
    "Open to anything": "∞",
    drive: "↗",
    ride: "⇄",
    bicycle: "◎",
    walk: "⌁",
  };
  const glyph = glyphs[value];
  return `<label class="choice ${checked ? "selected" : ""}"><input type="checkbox" aria-label="${esc(label.replace(/<[^>]*>/g, "").trim())}" name="${name}" value="${esc(value)}" ${checked ? "checked" : ""}>${glyph ? `<span class="choice-glyph" aria-hidden="true">${glyph}</span>` : ""}<span>${label}</span>${detail ? `<small>${detail}</small>` : ""}</label>`;
}
function renderWizard() {
  pointCleanups.forEach((fn) => fn());
  pointCleanups = [];
  const p = wizard.data,
    s = wizard.step;
  let body = "";
  if (s === 0)
    body = `<label class="group-label">Choose your avatar</label><div class="avatar-choices">${Object.entries(
      symbols,
    )
      .map(
        ([id, symbol]) =>
          `<label class="avatar-choice ${p.avatar === id ? "selected" : ""}"><input type="radio" name="avatar" value="${id}" ${p.avatar === id ? "checked" : ""}><span>${symbol}</span><small>${id[0].toUpperCase() + id.slice(1)}</small></label>`,
      )
      .join(
        "",
      )}</div>${field("What should we call you?", "name", "text", p.name, 'required maxlength="100"')}<p class="muted">${esc(state.user.email)}</p><label>How should outing invitations reach you?<select name="channel"><option value="email" ${p.channel === "email" ? "selected" : ""}>Email, with a link to respond here</option><option value="calendar" ${p.channel === "calendar" ? "selected" : ""}>Google Calendar invitation</option></select></label><p class="fineprint">Choose one channel for invitations and updates. You can always respond on the outing page.</p>`;
  if (s === 1)
    body = `<label class="address-field">Where does your journey begin?<input name="origin" id="origin-input" value="${esc(p.origin?.name || "")}" placeholder="Public meeting point" required></label><p class="fineprint">Use a public starting point. If you need a lift, it can be suggested as a pickup and shared with your driver.</p><p class="fineprint" id="location-status" role="status"></p><label>Timezone<input name="timezone" value="${esc(p.timezone)}" required></label><div class="slot-heading"><h3>Your available evenings</h3>${button("+ Add evening", "add-slot")}</div>${p.slots.map((slot, i) => `<fieldset class="slot"><legend>Evening ${i + 1}</legend><div class="slot-inputs">${field("Date", `date-${i}`, "date", slot.date, "required")}${field("Free from", `from-${i}`, "time", slot.from, "required")}${field("Home by", `until-${i}`, "time", slot.until, "required")}</div><div class="slot-footer"><label class="check-line"><input type="checkbox" name="weekly-${i}" ${slot.weekly ? "checked" : ""}>Repeat each week</label>${p.slots.length > 1 ? button("Remove", "remove-slot", `data-index="${i}"`) : ""}</div>${slot.weekly ? field("Repeat through (optional)", `through-${i}`, "date", slot.through || "") : ""}</fieldset>`).join("")}<small>Home by an earlier clock time means the following day. Include travel, setup and the journey home. Each recurrence keeps your local clock time.</small>`;
  if (s === 2)
    body = `<div class="choice-grid">${["Planets", "Stargazing", "Photography", "Learning", "Social evenings", "Open to anything"].map((t) => toggle(t, "interests", t, p.interests.includes(t))).join("")}</div><label>Anything else about your interests?<textarea name="interestNote" maxlength="1000" placeholder="A quiet photography session? A first look through a telescope?">${esc(p.interestNote)}</textarea></label><label>How well do you know the sky?<select name="experience"><option value="beginner" ${p.experience === "beginner" ? "selected" : ""}>Curious beginner</option><option value="experienced" ${p.experience === "experienced" ? "selected" : ""}>Experienced observer</option></select></label><label class="check-line"><input type="checkbox" name="happyToTeach" ${p.happyToTeach ? "checked" : ""}>I’m happy to help others learn</label>`;
  if (s === 3)
    body = `<div class="choice-grid">${[
      ["telescope", "Telescope", "A closer look at the planets."],
      ["binoculars", "Binoculars", "A little more sky in view."],
      ["camera", "Camera", "Bring the night home."],
      ["tripod", "Tripod", "Make time stand still."],
    ]
      .map(([v, l, d]) =>
        toggle(
          `${icon(v === "telescope" ? "telescope" : "spark", 24)} ${l}`,
          "equipment",
          v,
          p.equipment.includes(v),
          d,
        ),
      )
      .join(
        "",
      )}</div><label class="check-line"><input type="checkbox" name="shareEquipment" ${p.shareEquipment ? "checked" : ""}>I’m happy to share my equipment this evening</label><div class="soft-note">No equipment? You still bring curiosity. We’ll look for people happy to share.</div>`;
  if (s === 4)
    body = `<div class="choice-grid">${[
      ["drive", "I can drive", "I have a car available."],
      ["ride", "I’d love a lift", "Find a public place to meet."],
      ["bicycle", "By bicycle", "Take the scenic pace."],
      ["walk", "On foot", "Keep the adventure close."],
    ]
      .map(([v, l, d]) => toggle(l, "travel", v, p.travel.includes(v), d))
      .join(
        "",
      )}</div><small>Select every way you’re willing to travel. The plan proposes one for this outing.</small>${p.travel.includes("drive") ? `<fieldset><legend>Your car this evening</legend><label class="check-line"><input type="checkbox" name="carAvailable" ${p.car.available ? "checked" : ""}>My car is available</label><label class="check-line"><input type="checkbox" name="offerRides" ${p.car.offerRides ? "checked" : ""}>I’m happy to offer a lift</label><div class="form-grid">${field("Spare seats after equipment", "seats", "number", p.car.passengerSeats, 'min="0" max="7"')}${field("How many extra minutes would you drive to give someone a lift?", "detour", "number", p.car.maxDetourMinutes, 'min="0" max="120"')}</div><p class="fineprint">Your limit each way, including pickup and drop-off stops.</p><label class="group-label">Preferred public pickup points (optional)</label>${[0, 1, 2].map((i) => `<label class="address-field">Pickup ${i + 1}<input id="driver-pickup-${i}" value="${esc(p.car.pickupPoints[i]?.name || "")}" placeholder="Start typing a station or public place"></label>`).join("")}</fieldset>` : ""}${p.travel.includes("ride") ? `<label class="address-field">A public pickup point you prefer (optional)<input id="rider-pickup" value="${esc(p.pickup?.name || "")}" placeholder="Leave blank to use your public starting point"></label>` : ""}<div class="form-grid">${field("Maximum walking minutes each way", "walking", "number", p.maxWalkMinutes, 'min="0" max="120" required')}${field("Maximum journey minutes each way", "travelMinutes", "number", p.maxTravelMinutes, 'min="1" max="240" required')}</div><label>What matters most?<select name="preference">${[
      ["balanced", "A balance of sky and journey"],
      ["best_sky", "The best observing sky"],
      ["shortest_journey", "A shorter journey"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${p.preference === v ? "selected" : ""}>${l}</option>`,
      )
      .join("")}</select></label>`;
  if (s === 5)
    body = `<div class="soft-note"><strong>Your evening, your choice.</strong><p>These preferences will be remembered next time. Confirm your availability and offers for each new outing.</p></div><button class="primary full-width" type="submit">Organize my own evening →</button><div class="wizard-matches" id="final-matches">${offerCards(
      wizard,
    )}</div>`;
  modal.innerHTML = `<div class="modal-backdrop"><section class="journey-modal" role="dialog" aria-modal="true" aria-labelledby="wizard-title"><aside class="journey-side"><div class="eyebrow">YOUR STARGAZING PASSPORT</div><h2>Find your<br><em>kind of orbit.</em></h2>${passport(s)}<ol>${titles.map((t, i) => `<li class="${s === i ? "current" : s > i ? "done" : ""}"><span>${s > i ? "✓" : i + 1}</span>${esc(t.replace(".", ""))}</li>`).join("")}</ol></aside><div class="journey-main"><button class="modal-close" type="button" data-action="close-wizard" aria-label="Close">×</button><div class="wizard-progress"><i style="width:${((s + 1) / 6) * 100}%"></i></div><div class="eyebrow">STEP ${s + 1} OF 6</div><h2 id="wizard-title">${titles[s]}</h2><p class="muted">${subtitles[s]}</p><form id="wizard-form">${body}<div id="wizard-error" class="inline-error" role="alert"></div><div class="wizard-footer">${s > 0 ? button("← Back", "wizard-back") : "<span></span>"}${s < 5 ? '<button class="primary" type="submit">A little further →</button>' : ""}</div></form></div><aside class="match-sidebar"><div class="eyebrow">WHILE YOU DREAM</div><h3>Nights you could join.</h3><p class="fineprint">Suggestions get closer as you tell us more.</p><div id="side-matches">${offerCards(
    wizard,
  )}</div></aside></section></div>`;
  for (const [selector, key] of [
    ["#origin-input", "origin"],
    ["#rider-pickup", "pickup"],
    ...Array.from({ length: 3 }, (_, i) => [
      `#driver-pickup-${i}`,
      `driver-${i}`,
    ]),
  ]) {
    const input = $(selector);
    if (input)
      pointCleanups.push(
        autocomplete(input, {
          search: (args, opts) => call("autocomplete_address", args, opts),
          bias: () => locationContext().point,
          country: () => locationContext().country,
          onSelect: (point) => {
            if (key.startsWith("driver-"))
              wizard.data.car.pickupPoints[Number(key.at(-1))] = point;
            else wizard.data[key] = point;
            updateOffers();
          },
          onClear: () => {
            if (key.startsWith("driver-"))
              wizard.data.car.pickupPoints[Number(key.at(-1))] = null;
            else delete wizard.data[key];
          },
        }),
      );
  }
  if (s === 1) {
    const current = wizard;
    locate(call, $("#location-status"), () => {
      if (
        wizard === current &&
        document.activeElement === $("#origin-input")
      )
        pointCleanups[0]?.refresh();
    });
  }
  modal
    .querySelector(
      s === 0
        ? '#wizard-form input[name="name"]'
        : "#wizard-form input:not([type=hidden]), #wizard-form select, #wizard-form button",
    )
    ?.focus();
}
function collectWizard() {
  const form = $("#wizard-form");
  if (!form || !wizard) return;
  const f = new FormData(form),
    p = wizard.data,
    s = wizard.step;
  if (s === 0) {
    p.name = f.get("name");
    p.avatar = f.get("avatar");
    p.channel = f.get("channel");
  }
  if (s === 1) {
    p.timezone = f.get("timezone");
    p.slots = p.slots.map((slot, i) => ({
      date: f.get(`date-${i}`),
      from: f.get(`from-${i}`),
      until: f.get(`until-${i}`),
      weekly: f.has(`weekly-${i}`),
      ...(f.get(`through-${i}`) ? { through: f.get(`through-${i}`) } : {}),
    }));
  }
  if (s === 2) {
    p.interests = f.getAll("interests");
    p.interestNote = f.get("interestNote");
    p.experience = f.get("experience");
    p.happyToTeach = f.has("happyToTeach");
  }
  if (s === 3) {
    p.equipment = f.getAll("equipment");
    p.shareEquipment = f.has("shareEquipment");
  }
  if (s === 4) {
    p.travel = f.getAll("travel");
    p.maxWalkMinutes = Number(f.get("walking"));
    p.maxTravelMinutes = Number(f.get("travelMinutes"));
    p.preference = f.get("preference");
    if (f.has("seats"))
      Object.assign(p.car, {
        available: f.has("carAvailable"),
        offerRides: f.has("offerRides"),
        passengerSeats: Number(f.get("seats")),
        maxDetourMinutes: Number(f.get("detour")),
      });
  }
}
function offerCards(current) {
  const cards = current.offers
    .slice(0, 3)
    .map((o) => card(o, true))
    .join("");
  const note =
    current.otherEvenings && cards
      ? '<p class="muted">No outings fit your selected evenings yet. These other dates have places available.</p>'
      : "";
  return (
    matchingNote(current.offers) + note + cards ||
    `<p class="muted">${current.offersLoaded ? "No open outings with places available yet. You can organize your own evening." : "Looking for open places…"}</p>`
  );
}
async function updateOffers() {
  clearTimeout(offerTimer);
  const current = wizard;
  if (!current) return;
  const revision = (current.offerRevision =
    (current.offerRevision || 0) + 1);
  offerTimer = setTimeout(async () => {
    try {
      const partial = wizardPreferences(current.data, true);
      let found = await call("find_outings", {
        preferences: partial,
      });
      const otherEvenings = !found.length;
      if (otherEvenings)
        found = await call("find_outings", {
          preferences: partial,
          anyDate: true,
        });
      if (wizard !== current || current.offerRevision !== revision) return;
      Object.assign(current, {
        offers: found,
        otherEvenings,
        offersLoaded: true,
      });
      for (const selector of ["#side-matches", "#final-matches"]) {
        const el = $(selector);
        if (el) el.innerHTML = offerCards(current);
      }
      if (found.some((o) => o.matching?.status === "pending")) {
        offerTimer = setTimeout(() => {
          if (wizard === current) updateOffers();
        }, 1500);
      }
    } catch (error) {
      if (wizard !== current || current.offerRevision !== revision) return;
      for (const selector of ["#side-matches", "#final-matches"]) {
        const el = $(selector);
        if (el)
          el.textContent =
            "Couldn’t load outings. You can keep planning your own evening.";
      }
    }
  }, 400);
}
function wizardPreferences(data, partial = false) {
  const preferences = structuredClone(data);
  preferences.car.pickupPoints =
    preferences.car.pickupPoints.filter(Boolean);
  if (partial) {
    if (!preferences.name?.trim()) delete preferences.name;
    if (!preferences.origin) delete preferences.origin;
    if (!preferences.travel.length) delete preferences.travel;
    preferences.slots = preferences.slots.filter(
      (slot) => slot.date && slot.from && slot.until,
    );
    if (!preferences.slots.length) delete preferences.slots;
  }
  return preferences;
}
async function saveWizard({ partial = false } = {}) {
  collectWizard();
  await call("save_preferences", wizardPreferences(wizard.data, partial));
  await refresh();
}
function organizerForm(saved) {
  const proposed = defaultPlanningWindow(
    state.planningWindows,
    state.user.preferences,
  );
  const from = proposed.start,
    until = proposed.end;
  modal.innerHTML = `<div class="modal-backdrop"><section class="panel plan-modal" role="dialog" aria-modal="true" aria-labelledby="plan-title"><button type="button" class="modal-close" data-action="close-wizard" aria-label="Close">×</button><div class="eyebrow">MAKE A LITTLE ROOM FOR WONDER</div><h2 id="plan-title">Create your outing.</h2><form id="plan-form"><label>Plan with<select name="solver"><option value="codex" ${state.solver?.defaultBackend !== "deterministic" ? "selected" : ""}>Codex agent</option><option value="deterministic" ${state.solver?.defaultBackend === "deterministic" ? "selected" : ""}>Rule-based planner</option></select></label><label>What would you like to see?<select name="target"><option value="stargazing">A sky full of stars</option><option>Saturn</option><option>Moon</option><option>Jupiter</option><option>Mars</option></select></label><div class="form-grid">${field("Available from", "start", "datetime-local", local(from), "required")}${field("Home by", "end", "datetime-local", local(until), "required")}</div><p class="fineprint">Include travel both ways, 15 minutes to set up and 15 minutes to pack up. After midnight? Choose the following date.</p><p id="planning-range" class="mint"></p>${proposed.adjusted && !saved ? '<p class="fineprint">Your saved availability was too short for a full evening. We’ve suggested a later Home by; adjust it to suit this outing.</p>' : ""}<p class="fineprint">Times above use this browser’s timezone (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}). Saved availability uses ${esc(state.user.preferences.timezone)}.</p><div class="form-grid">${field("Observing minutes", "duration", "number", 60, 'min="30" max="180" required')}${field("Minimum people", "min", "number", 2, 'min="1" max="8" required')}${field("Maximum people", "max", "number", 4, 'min="1" max="8" required')}</div><label>Who can join?<select name="visibility"><option value="open">Open remaining places to others</option><option value="circle">My circle only</option></select></label><label class="check-line"><input type="checkbox" name="guide">We’d like someone happy to teach</label>${state.circle.length ? `<fieldset><legend>Suggest company from your circle (up to 7)</legend>${state.circle.map((p, i) => `<label class="check-line"><input type="checkbox" name="person" value="${p.id}" ${i < 7 ? "checked" : ""}>${esc(p.name)}</label>`).join("")}</fieldset>` : '<div class="soft-note">Your circle can grow over time. Create an open evening so other people can join.</div>'}<div class="inline-error" id="plan-error" role="alert"></div><button class="primary">Create outing →</button><p class="fineprint">We’ll create a draft with a suitable place and viewing time. You review it before opening places or sending invitations. Missing lifts stay marked “Driver needed”.</p><div id="plan-progress" class="fineprint" role="status"></div><button type="button" class="secondary" data-action="stop-plan" id="stop-plan" hidden>Stop planning</button></form></section></div>`;
  if (saved) {
    for (const input of $("#plan-form").elements) {
      if (!input.name) continue;
      const values = saved
        .filter(([name]) => name === input.name)
        .map(([, value]) => value);
      if (["checkbox", "radio"].includes(input.type))
        input.checked = values.includes(input.value);
      else if (values.length) input.value = values[0];
    }
  }
  const form = $("#plan-form");
  const updateRange = () => {
    const from = new Date(form.elements.start.value),
      until = new Date(form.elements.end.value);
    const format = new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    $("#planning-range").textContent =
      Number.isFinite(+from) && Number.isFinite(+until)
        ? `${format.format(from)} → ${format.format(until)} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
        : "";
    $("#plan-error").textContent = "";
  };
  form.addEventListener("input", updateRange);
  updateRange();
  drawPlanningProgress();
}
function drawPlanningProgress() {
  const form = $("#plan-form");
  if (!form) return;
  const running = activePlan?.status === "running";
  form.querySelector("button.primary").disabled = Boolean(running);
  for (const input of form.elements)
    if (input.name) input.disabled = Boolean(running);
  $("#stop-plan").hidden = !running;
  $("#plan-progress").textContent = running
    ? activePlan.events?.at(-1)?.message || "Starting your planning agent…"
    : "";
}
async function startPlanning(input) {
  if (activePlan) return;
  const started = await call("start_plan", input);
  const job = (activePlan = started);
  drawPlanningProgress();
  try {
    while (job.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (activePlan !== job) return;
      Object.assign(job, await call("get_plan_job", { jobId: job.id }));
      drawPlanningProgress();
    }
    if (job.status === "cancelled") return;
    if (job.status === "failed") throw new Error(job.error);
    const result = job.result;
    if (result.status === "no_match") throw new Error(result.reason);
    activePlan = null;
    if ($("#plan-form")) {
      pausedPlanning = null;
      modal.replaceChildren();
      await showOuting(result.id);
    } else {
      pausedPlanning = { outingId: result.id };
      toast(
        "Your outing draft is ready. Open Plan your next adventure to review it.",
      );
    }
  } catch (error) {
    if ($("#plan-error")) $("#plan-error").textContent = error.message;
    else toast(error.message);
  } finally {
    if (activePlan === job) activePlan = null;
    drawPlanningProgress();
  }
}
function deliveryNotice(o) {
  if (!o.calendar?.state) return "";
  const message =
    o.deliveryMode === "codex" && o.calendar.state !== "sent"
      ? "Calendar invitations or updates are waiting for the organizer to send them through Codex. You can respond on this page."
      : o.calendar.state === "needs_connection"
        ? "Calendar invitation pending: the organizer needs to connect Google. Your Calendar preference is saved; you can respond here."
        : "";
  return message
    ? `<div class="soft-note gold" role="status">${esc(message)}</div>`
    : "";
}
function solverReport(o) {
  if (!o.solver) return "";
  return `<section class="panel"><div class="eyebrow">${o.solver.backend === "codex" ? "PLANNED WITH CODEX" : "RULE-BASED PLAN"}</div><h2>Why this plan.</h2><p>${esc(o.solver.summary)}</p>${o.solver.trace ? `<details><summary>Planning checks (${o.solver.trace.length})</summary><ul>${o.solver.trace.map((t) => `<li>${esc(t.tool.replaceAll("_", " "))} · ${esc(t.status)}${t.error ? ` — ${esc(t.error)}` : ""}</li>`).join("")}</ul></details>` : ""}</section>`;
}
function skyReport(o) {
  if (o.kind === "connection_test") return "";
  const a = o.astronomy,
    w = o.weather;
  return `<section class="panel sky-panel"><div class="eyebrow">A WINDOW INTO THE NIGHT</div><h2>Your sky report.</h2><div class="report-columns"><div><h3>${icon("moon")} Astronomy</h3>${a ? `<div class="report-stats"><div><strong>${a.minTargetAltitude == null ? "All sky" : Math.round(a.minTargetAltitude) + "°"}</strong><span>${a.minTargetAltitude == null ? "constellations & stars" : "minimum target altitude"}</span></div><div><strong>${Math.round(a.moonIllumination * 100)}%</strong><span>Moon illuminated</span></div><div><strong>${Math.round(a.maxSunAltitude)}°</strong><span>highest Sun altitude</span></div><div><strong>${Math.round(a.maxMoonAltitude)}°</strong><span>highest Moon altitude</span></div></div><p class="${a.suitable ? "mint" : "gold"}">${a.suitable ? "Darkness and target visibility fit the window." : "Visibility needs review for this window."}</p><small>Astronomy Engine · sampled every ${a.sampleMinutes || 15} minutes.<br>Level horizon assumed; terrain and trees can obstruct the view.</small>` : "<p>No astronomy report is available for this event.</p>"}</div><div><h3>${icon("sun")} Expected weather</h3>${w ? `<div class="report-stats"><div><strong>${Math.round(w.maxCloudCover)}%</strong><span>maximum cloud</span></div><div><strong>${Math.round(w.maxWindKmh)} km/h</strong><span>maximum wind</span></div><div><strong>${Math.round(w.minTemperatureC)}°C</strong><span>minimum temperature</span></div><div><strong>${Math.round(w.maxPrecipitationProbability || 0)}%</strong><span>chance of rain</span></div></div><p class="${w.suitable ? "mint" : "gold"}">${w.suitable ? "Within the planning limits when checked." : "Conditions need review before going."}</p><small>Forecast retrieved ${esc(date(w.fetchedAt, o.timezone))}.<br>Forecasts can change; check again before departure.</small>` : "<p>Forecast not available.</p>"}${o.organizer && o.kind !== "connection_test" && !closed.includes(o.status) ? button("Refresh weather ↻", "weather") : ""}</div></div></section>`;
}
function commentsTree(comments, parent) {
  return comments
    .filter((c) => (c.replyTo || null) === (parent || null))
    .map(
      (c) =>
        `<article class="thread-comment" id="comment-${c.id}"><div class="comment-meta"><strong>${esc(c.authorName)}</strong><small>${esc(date(c.createdAt))}</small></div><p>${esc(c.text)}</p>${button("Reply", "reply", `data-id="${c.id}"`)}<div class="comment-replies">${commentsTree(comments, c.id)}</div></article>`,
    )
    .join("");
}
async function showOuting(id, push = true) {
  outing = await call("get_outing", { outingId: id });
  view = "outings";
  if (push) {
    history.pushState({}, "", `/outing/${id}`);
    window.scrollTo(0, 0);
  }
  const o = outing,
    me = o.people.find((p) => p.id === state.user.id),
    isClosed = closed.includes(o.status);
  if (wizard) {
    modal.replaceChildren();
    wizard = null;
  }
  shell(
    `<section class="outing-heading"><div><div class="eyebrow">${o.status === "draft" ? "YOUR OUTING DRAFT" : o.visibility === "open" ? "AN OPEN INVITATION" : "AN EVENING WITH YOUR CIRCLE"} · REVISION ${o.revision}</div><h1>${esc(o.title)}</h1><div class="outing-subtitle"><span class="status-chip ${o.status}">${esc(o.statusLabel)}</span><span>${esc(date(o.start, o.timezone))} – ${esc(new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: o.timezone }).format(new Date(o.end)))}</span></div><p>${esc(o.site.name)} · ${esc(o.timezone)}</p></div><div class="outing-illustration" aria-hidden="true">${skyIllustration(o.target)}</div></section>${o.reasons.length ? `<div class="soft-note gold">${o.reasons.map(esc).join("<br>")}</div>` : ""}<div class="outing-columns"><section class="panel"><h2>${me ? "Your place under the stars." : "There’s room for you."}</h2><p>${isClosed ? "This outing is closed." : o.status === "draft" ? "Review the suggested group, check access, then invite." : me && me.revision < o.revision ? "The plan changed. Review the details and reconfirm here." : "Your answer confirms the travel and equipment arrangements shown on this page."}</p>${me?.conflict ? `<div class="soft-note gold">${esc(me.conflict)}</div>` : ""}${me?.needsDetails ? '<div class="soft-note gold">We haven’t checked your availability or journey yet. Confirm the meeting times and choose how you’ll get there.</div>' : ""}${
      me &&
      !isClosed &&
      o.status !== "draft" &&
      (o.organizer || !["declined", "expired"].includes(me.response))
        ? `<div class="response-actions">${[
            ["accepted", me.needsDetails ? "Check my journey & join →" : "I’m in ✓"],
            ["tentative", "Maybe"],
            ["declined", "Can’t make it"],
          ]
            .map(([v, l]) =>
              button(
                l,
                v === "accepted" && me.needsDetails ? "join" : "respond",
                `data-response="${v}" ${me.response === v && me.revision === o.revision ? 'aria-pressed="true"' : ""}`,
                v === "accepted",
              ),
            )
            .join("")}</div>`
        : ""
    }${!isClosed && o.canJoin && !me?.needsDetails ? button("Check my journey & join →", "join", "", true) : ""}${o.deadline && !isClosed ? `<p class="fineprint">Reply by ${esc(date(o.deadline, o.timezone))}. ${o.remaining} unreserved places remain.${o.driverPlaces ? " One additional place is reserved for a driver." : ""}</p>` : ""}${o.organizer && !isClosed ? `<details ${o.status === "draft" ? "open" : ""}><summary>${o.status === "draft" ? "Review & invite" : "Invite more people"}</summary><form id="invite-form"><fieldset><legend>People to invite from your circle</legend>${state.circle.map((p) => `<label class="check-line"><input name="person" type="checkbox" value="${p.id}" ${o.people.some((m) => m.id === p.id && !["declined", "expired"].includes(m.response)) ? "checked" : ""}>${esc(p.name)}</label>${p.missingDetails?.length ? `<p class="fineprint gold">${esc(p.name)} has not filled in ${esc(p.missingDetails.join(", "))}. You can invite them; availability and journey checks will wait for their answers.</p>` : ""}`).join("") || "<p>Your open outing can welcome people before your circle grows.</p>"}</fieldset><label>Visibility<select name="visibility"><option value="open" ${o.visibility === "open" ? "selected" : ""}>Open remaining places</option><option value="circle" ${o.visibility === "circle" ? "selected" : ""}>Circle only</option></select></label>${field("Reserve invitation places for (hours)", "holdHours", "number", o.invitationHoldHours, 'min="1" max="168"')}${field("Final response deadline", "deadline", "datetime-local", local(o.deadline || Date.parse(o.start) - 1800000), "required")}<p class="fineprint">Calendar guests receive an event; email guests receive a page link. The organizer counts toward the ${o.maxPeople}-person limit.</p>${!o.accessConfirmed ? '<p class="gold">Check night access below before opening this outing.</p>' : ""}<div class="inline-error" role="alert" aria-live="polite"></div><button class="primary" ${!o.accessConfirmed ? "disabled" : ""}>${o.status === "draft" ? "Invite selected & open outing →" : "Invite selected →"}</button></form></details>` : ""}</section><section class="panel"><h2>Your constellation.</h2>${o.people
      .map(
        (p) =>
          `<div class="person-row"><span class="avatar ${p.avatar}">${symbols[p.avatar]}</span><div class="person-info"><strong>${esc(p.name)}${p.id === state.user.id ? " · you" : ""}</strong><div class="role-tags">${[
            p.organizer ? "Organizer" : null,
            ...p.roles,
          ]
            .filter(Boolean)
            .map((r) => `<span>${esc(r)}</span>`)
            .join(
              "",
            )}</div><small>${esc(p.response)}${p.needsDetails ? " · availability and journey not checked" : ""}${!isClosed && p.revision < o.revision ? " · reconfirmation needed" : ""}${!isClosed && p.reservedUntil && ["pending", "tentative"].includes(p.response) ? ` · reserved until ${esc(date(p.reservedUntil, o.timezone))}` : ""}</small>${p.id !== state.user.id && !state.circle.some((f) => f.id === p.id) && me ? button("Invite to my circle", "circle-person", `data-id="${p.id}"`) : ""}</div></div>`,
      )
      .join(
        "",
      )}</section></div>${deliveryNotice(o)}${solverReport(o)}${skyReport(o)}${trafficPanel(o)}<div class="outing-columns"><section class="panel"><h2>The journey, together.</h2>${o.routes
      .filter(() => me && !["declined", "expired"].includes(me.response))
      .map(
        (r) =>
          `<div class="soft-note"><strong>Your journey · ${r.selfArranged ? "self-arranged" : esc(r.mode)}</strong><p>${r.selfArranged ? `Meet ${esc(date(r.meetAt, o.timezone))}<br>Ready to leave ${esc(date(r.leaveAt, o.timezone))}<br>Your journey home is self-arranged.` : `${r.pickupOnly ? "Be at the pickup by" : "Leave"} ${esc(date(r.departAt, o.timezone))}<br>${r.pickupOnly ? "Back at the pickup by" : "Home by"} ${esc(date(r.homeBy, o.timezone))}${r.pickupOnly ? "<br>Your travel to and from this pickup is self-arranged." : ""}`}</p>${r.selfArranged ? "" : `<a href="${esc(r.mode === "ride" ? r.pickupNavigationUrl : o.carpools.find((c) => c.driverId === state.user.id)?.outboundNavigationUrl || r.navigationUrl)}" target="_blank" rel="noreferrer">${r.mode === "ride" ? "Walk to pickup" : "Open outward route"} ↗</a>`}</div>`,
      )
      .join(
        "",
      )}${o.carpools.map((c) => `<div class="ride-card"><h3>${esc(c.driverName)} · driver${["declined", "expired"].includes(o.people.find((person) => person.id === c.driverId)?.response) ? " · needs replacement" : ""}</h3>${c.pickups.map((p) => `<p><strong>${esc(p.name)}</strong>${["declined", "expired"].includes(o.people.find((person) => person.id === p.participantId)?.response) ? " · no longer joining" : ""} · ${esc(p.pickup.name)}<br><small>Pickup ${esc(date(p.pickupAt, o.timezone))} · Return ${esc(date(p.dropoffAt, o.timezone))}</small></p>`).join("")}${c.driverId === state.user.id ? `<a href="${esc(c.returnNavigationUrl)}" target="_blank" rel="noreferrer">Return route with drop-offs ↗</a>` : ""}</div>`).join("")}<p>${esc(o.traffic?.description || "Journeys include setup, pack-up and the return home.")}</p></section><section class="panel"><h2>A place to meet.</h2><h3>${esc(o.site.name)}</h3><p>${esc(o.site.accessNote)}</p><p>${o.site.walkMinutes} minutes walking from the meeting point, each way.</p><h3>What we’re bringing</h3>${o.equipment.map((item) => `<p>${esc(item)}</p>`).join("")}${!o.accessConfirmed ? '<div class="soft-note gold">Night access needs the organizer’s confirmation before invitations can be sent.</div>' : ""}</section></div>${o.canComment ? `<section class="panel conversation"><h2>A little conversation.</h2><p class="muted">Comments notify the organizer. Replies also notify the person you reply to.</p>${commentsTree(o.comments) || "<p>No comments yet. Say hello.</p>"}<form id="comment-form"><div id="reply-label" class="mint"></div><label>Your comment<textarea name="text" maxlength="2000" required placeholder="Ask about a pickup, the equipment, or the plan…"></textarea></label><button class="primary">Post comment →</button></form></section>` : ""}${o.organizer ? organizerTools(o) : ""}`,
    "outings",
    "Outing",
  );
  loadTraffic(o);
}
function trafficPanel(o) {
  if (
    o.kind === "connection_test" ||
    !o.people.some(
      (p) =>
        p.transport === "drive" &&
        !["declined", "expired", "withdrawn"].includes(p.response),
    )
  )
    return "";
  return `<section class="panel traffic-panel"><div class="eyebrow">THE ROAD TO YOUR EVENING</div><h2>Expected traffic situation</h2><div id="traffic-report" role="status">Checking driving estimates…</div></section>`;
}
async function loadTraffic(o) {
  const panel = $("#traffic-report");
  if (!panel) return;
  try {
    const report = await call("get_traffic_report", {
      outingId: o.id,
    });
    if (!panel.isConnected) return;
    if (!report) {
      panel.closest("section").remove();
      return;
    }
    const leg = (label, r) =>
      `<div><strong>${r.minutes == null ? "Unavailable" : r.minutes + " min"}</strong><span>${label}</span><small>${r.freeFlowMinutes == null ? "Free-flow comparison unavailable" : `${r.freeFlowMinutes} min free-flow`}${r.differenceMinutes == null ? "" : ` · ${r.differenceMinutes > 0 ? "+" : ""}${r.differenceMinutes} min difference`}</small></div>`;
    panel.innerHTML =
      report.drivers
        .map(
          (d) =>
            `<h3>${esc(d.name)} · driver</h3><div class="report-stats">${leg("Outward driving", d.outward)}${leg("Return driving", d.homeward)}</div>${d.unavailable ? '<p class="gold">Some estimates are unavailable. Try again shortly.</p>' : ""}`,
        )
        .join("") +
      `<p>${esc(report.description)}</p><small>${esc(report.provider)} · checked ${esc(date(report.checkedAt, o.timezone))}</small>`;
  } catch {
    if (panel.isConnected)
      panel.textContent =
        "Driving estimates are unavailable. Reopen this outing to try again.";
  }
}
function organizerTools(o) {
  const own = o.people.find((p) => p.id === state.user.id);
  const window =
    own?.availability?.find(
      (w) =>
        Date.parse(w.start) <= Date.parse(o.start) &&
        Date.parse(w.end) >= Date.parse(o.end),
    ) || own?.availability?.[0];
  const availabilityFields =
    o.kind !== "connection_test" && window
      ? `<fieldset><legend>Your availability for this outing</legend><div class="form-grid">${field("Your available from", "availableFrom", "datetime-local", local(window.start), "required")}${field("Your home by", "homeBy", "datetime-local", local(window.end), "required")}</div><small>These hours include your complete journey. Changing them applies to this outing only; other participants keep their own limits.</small></fieldset>`
      : "";
  return `<section class="panel organizer-tools"><h2>Keep the plan together.</h2>${o.calendar?.state ? `<p>Calendar delivery: <strong>${esc(o.calendar.state.replaceAll("_", " "))}</strong> · checked ${esc(date(o.calendar.checkedAt))}</p>${o.calendar.error ? `<div class="soft-note gold">${esc(o.calendar.error)}</div>` : ""}<div class="button-row">${o.deliveryMode === "codex" ? '<p class="fineprint">Open Codex to send pending notifications or check responses through your Calendar integration.</p>' : button("Check Calendar responses ↻", "sync") + button("Reconcile Calendar event", "recover")}</div>` : ""}${!closed.includes(o.status) ? `<details><summary>Edit time, place or night access</summary><p>Changes to the time, site or meeting point require participants to reconfirm. The same Calendar event is updated. Declined participants do not block the new plan.</p><form id="edit-form"><div class="form-grid">${field("Observing from", "start", "datetime-local", local(o.start), "required")}${field("Observing until", "end", "datetime-local", local(o.end), "required")}</div><small>Times use your browser timezone.</small>${availabilityFields}<label class="address-field">Observing place<input id="edit-site" name="site" value="${esc(o.site.name)}" required></label><label class="address-field">Public meeting point (optional)<input id="edit-meeting" value="${esc(o.site.meetingPoint.lat + ", " + o.site.meetingPoint.lon)}" placeholder="Leave unchanged or choose a new public meeting point"></label>${field("Minutes walking from meeting point", "walk", "number", o.site.walkMinutes, 'min="0" max="120" required')}<label>Night access notes<textarea name="note" required minlength="10">${esc(o.site.accessNote)}</textarea></label><label class="check-line"><input type="checkbox" name="confirmed" ${o.accessConfirmed ? "checked" : ""}>I checked access and the meeting point for this night</label><button class="primary">Check & update plan →</button></form></details><details><summary>Cancel this outing</summary><form id="cancel-form"><label>Reason<textarea name="reason" required maxlength="1000" placeholder="For example, the cloud forecast has worsened."></textarea></label><button class="secondary">Cancel outing</button></form></details>` : ""}</section>`;
}

document.addEventListener("change", (e) => {
  if (wizard && e.target.closest("#wizard-form")) {
    const oldTravel = wizard.data.travel.join(),
      oldWeekly = wizard.data.slots.map((s) => s.weekly).join();
    burstFrom(e.target.closest(".choice,.avatar-choice"), {
      count: 12,
      spread: 0.55,
    });
    collectWizard();
    e.target
      .closest(".choice")
      ?.classList.toggle("selected", e.target.checked);
    if (e.target.name === "avatar")
      document
        .querySelectorAll(".avatar-choice")
        .forEach((n) =>
          n.classList.toggle("selected", n.querySelector("input").checked),
        );
    if (
      oldTravel !== wizard.data.travel.join() ||
      oldWeekly !== wizard.data.slots.map((s) => s.weekly).join()
    )
      renderWizard();
    updateOffers();
  }
});
document.addEventListener("input", (e) => {
  if (
    wizard &&
    e.target.closest("#wizard-form") &&
    !["checkbox", "radio"].includes(e.target.type) &&
    !e.target.closest(".address-field")
  ) {
    collectWizard();
    updateOffers();
  }
});
function closePlanningDialog() {
  if (wizard) {
    collectWizard();
    pausedPlanning = { wizard: structuredClone(wizard) };
  } else if ($("#plan-form")) {
    pausedPlanning = {
      form: [...$("#plan-form").elements]
        .filter(
          (input) =>
            input.name &&
            (!["checkbox", "radio"].includes(input.type) || input.checked),
        )
        .map((input) => [input.name, input.value]),
    };
  }
  wizard = null;
  modal.replaceChildren();
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modal.children.length) closePlanningDialog();
  if (e.key === "Tab" && modal.querySelector("[role=dialog]")) {
    const nodes = [
      ...modal.querySelectorAll("button,input,select,textarea,a"),
    ].filter((n) => !n.disabled && n.offsetParent !== null);
    if (e.shiftKey && document.activeElement === nodes[0]) {
      e.preventDefault();
      nodes.at(-1).focus();
    } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
      e.preventDefault();
      nodes[0].focus();
    }
  }
});
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  e.preventDefault();
  const a = el.dataset.action;
  if (el.disabled) return;
  try {
    if (a === "cycle-sky") {
      const choices = ["Saturn", "Moon", "stargazing"];
      skyTarget =
        choices[(choices.indexOf(skyTarget) + 1) % choices.length];
      const wrapper = el.closest(".sky-illustration");
      wrapper.outerHTML = skyIllustration(skyTarget, true);
      const stage = $(".hub-hero .hero-stage");
      stage.closest(".sky-illustration").classList.add("target-changed");
      stage.focus({ preventScroll: true });
      burstFrom(stage, { count: 20, spread: 0.8 });
      return;
    }
    if (a === "view") {
      if (el.classList.contains("brand")) meteorShower(10);
      return navigate(el.dataset.view);
    }
    if (a === "settings") return navigate("settings");
    if (a === "edit-profile") return navigate("profile");
    if (a === "signin") return requestSignin();
    if (a === "preferences") {
      if (!bootstrap.user) return requestSignin("/?view=plan");
      return openWizard();
    }
    if (a === "stop-plan" && activePlan) {
      await call("cancel_plan_job", { jobId: activePlan.id });
      activePlan = null;
      drawPlanningProgress();
      toast("Planning stopped. Your answers are still here.");
      return;
    }
    if (a === "close-wizard") return closePlanningDialog();
    if (a === "wizard-back") {
      collectWizard();
      wizard.step--;
      return renderWizard();
    }
    if (a === "add-slot") {
      collectWizard();
      if (wizard.data.slots.length >= 12)
        throw new Error("Use up to 12 availability slots.");
      wizard.data.slots.push({ ...wizard.data.slots.at(-1) });
      return renderWizard();
    }
    if (a === "remove-slot") {
      collectWizard();
      wizard.data.slots.splice(Number(el.dataset.index), 1);
      return renderWizard();
    }
    if (a === "reply") {
      replyTo = el.dataset.id;
      $("#reply-label").textContent =
        "Replying to " +
        outing.comments.find((c) => c.id === replyTo).authorName;
      $("#comment-form textarea").focus();
      return;
    }
    el.disabled = true;
    if (a === "confirm-signin") {
      const token = location.hash.slice(1);
      const result = await http("/auth/confirm", { token });
      history.replaceState({}, "", result.returnTo || "/");
      view = new URLSearchParams(location.search).get("view") || "explore";
      bootstrap = await http("/api/bootstrap");
      return render();
    }
    if (a === "logout") {
      await http("/auth/logout", {});
      location.href = "/";
      return;
    }
    if (a === "outbox") return outbox();
    if (a === "outing") {
      if (!bootstrap.user) return showPublicOuting(el.dataset.id);
      if (wizard) await saveWizard({ partial: true });
      wizard = null;
      modal.replaceChildren();
      return showOuting(el.dataset.id);
    }
    if (a === "circle-respond") {
      await call("respond_circle", {
        invitationId: el.dataset.id,
        accept: el.dataset.accept === "true",
      });
      await refresh();
      if (el.dataset.accept === "true") celebrate();
      return circle();
    }
    if (a === "circle-person") {
      await call("invite_to_circle", { userId: el.dataset.id });
      toast("Circle invitation sent.");
      return;
    }
    if (a === "join") {
      wizard = null;
      return openJoin(modal, {
        outing,
        user: state.user,
        call,
        onJoined: async () => {
          celebrate();
          toast("You joined the evening.");
          await refresh();
          await showOuting(outing.id, false);
        },
      });
    }
    if (a === "respond") {
      await call("respond_outing", {
        outingId: outing.id,
        response: el.dataset.response,
        revision: outing.revision,
      });
      return showOuting(outing.id, false);
    }
    if (["weather", "sync", "recover"].includes(a)) {
      await call(
        {
          weather: "refresh_weather",
          sync: "check_calendar",
          recover: "recover_calendar",
        }[a],
        { outingId: outing.id },
      );
      return showOuting(outing.id, false);
    }
    if (a === "connect-google") {
      const result = await call("connect_google");
      location.href = result.url;
      return;
    }
    if (a === "disconnect-google") {
      await http("/auth/disconnect-google", {});
      await refresh();
      return settings();
    }
    if (a === "mcp-token") {
      const result = await http("/auth/mcp-token", {});
      $("#token-result").innerHTML =
        `<p>Copy this token once into your environment:</p><input type="password" readonly value="${esc(result.token)}" aria-label="MCP access token"><p><code>STAR_GAZER_URL=${esc(result.endpoint.replace("/mcp", ""))}<br>STAR_GAZER_TOKEN=&lt;token above&gt;</code></p><small>The StarGazer package reads these environment variables.</small>`;
      $("#token-result input").addEventListener("click", (e) => {
        e.target.type = "text";
        e.target.select();
      });
      return;
    }
    if (a === "revoke-token") {
      await http("/auth/revoke-mcp", {});
      $("#token-result").replaceChildren();
      toast("MCP access revoked.");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    if (el.isConnected) el.disabled = false;
  }
});
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (
    ![
      "connection-test-form",
      "signin-form",
      "wizard-form",
      "plan-form",
      "circle-form",
      "invite-form",
      "comment-form",
      "edit-form",
      "cancel-form",
    ].includes(form.id)
  )
    return;
  e.preventDefault();
  const submit = form.querySelector(
    "button[type=submit],button.primary:not([type]),button.secondary:not([type])",
  );
  if (submit?.disabled) return;
  if (submit) submit.disabled = true;
  const f = new FormData(form);
  try {
    if (form.id === "connection-test-form") {
      const result = await call("send_connection_test", {
        guestEmail: f.get("guestEmail"),
        start: new Date(f.get("start")).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        channel: f.get("channel"),
      });
      return showOuting(result.id);
    }
    if (form.id === "signin-form") {
      const r = await http("/auth/request", {
        email: f.get("email"),
        returnTo:
          location.pathname === "/signin"
            ? new URLSearchParams(location.search).get("returnTo") || "/"
            : location.pathname + location.search,
      });
      toast(r.message);
      return;
    }
    if (form.id === "wizard-form") {
      collectWizard();
      if (wizard.step === 1 && !wizard.data.origin)
        throw new Error(
          "Choose a starting point from the address suggestions.",
        );
      if (wizard.step === 4 && !wizard.data.travel.length)
        throw new Error("Choose at least one way you can travel.");
      if (
        wizard.step === 4 &&
        wizard.data.travel.every((mode) => mode === "drive") &&
        !wizard.data.car.available
      )
        throw new Error(
          "Confirm that your car is available, or choose another way to travel.",
        );
      if (wizard.step < 5) {
        wizard.step++;
        renderWizard();
        burstFrom($(".wizard-progress"), { count: 12, spread: 0.5 });
        updateOffers();
        return;
      }
      await saveWizard();
      wizard = null;
      return organizerForm();
    }
    if (form.id === "plan-form") {
      $("#plan-error").textContent = "";
      const problem = planningWindowProblem(
        {
          start: f.get("start"),
          end: f.get("end"),
          durationMinutes: Number(f.get("duration")),
        },
        { preparation: true },
      );
      if (problem) throw new Error(problem.message);
      const progress = $("#plan-progress");
      progress.textContent =
        "Creating your outing: choosing a place and viewing time, checking weather and travel arrangements…";
      await startPlanning({
        solver: f.get("solver"),
        target: f.get("target"),
        start: new Date(f.get("start")).toISOString(),
        end: new Date(f.get("end")).toISOString(),
        durationMinutes: Number(f.get("duration")),
        minPeople: Number(f.get("min")),
        maxPeople: Number(f.get("max")),
        visibility: f.get("visibility"),
        needsGuide: f.has("guide"),
        participantIds: f.getAll("person"),
      });
      return;
    }
    if (form.id === "circle-form") {
      await call("invite_to_circle", { email: f.get("email") });
      await refresh();
      toast("Circle invitation sent.");
      return circle();
    }
    if (form.id === "invite-form") {
      form.querySelector(".inline-error").textContent = "";
      await call("invite_outing", {
        outingId: outing.id,
        participantIds: f.getAll("person"),
        holdHours: Number(f.get("holdHours")),
        deadline: new Date(f.get("deadline")).toISOString(),
        visibility: f.get("visibility"),
      });
      toast("Outing opened. Invitations are queued for delivery.");
      return showOuting(outing.id, false);
    }
    if (form.id === "comment-form") {
      await call("add_comment", {
        outingId: outing.id,
        text: f.get("text"),
        ...(replyTo ? { replyTo } : {}),
      });
      replyTo = null;
      return showOuting(outing.id, false);
    }
    if (form.id === "edit-form") {
      if (form.siteUnselected || form.meetingUnselected)
        throw new Error(
          "Choose the changed place from the address suggestions.",
        );
      const site = {
        ...outing.site,
        ...(form.selectedSite
          ? {
              name: form.selectedSite.name,
              location: form.selectedSite.location,
              meetingPoint: form.selectedSite.location,
            }
          : {}),
        ...(form.selectedMeeting
          ? { meetingPoint: form.selectedMeeting.location }
          : {}),
        walkMinutes: Number(f.get("walk")),
        accessNote: f.get("note"),
        access: f.has("confirmed") ? "confirmed" : "unverified",
      };
      const start = new Date(f.get("start")).toISOString(),
        end = new Date(f.get("end")).toISOString();
      site.accessWindows = [
        {
          start: new Date(
            Date.parse(start) - (15 + site.walkMinutes) * 60000,
          ).toISOString(),
          end: new Date(
            Date.parse(end) + (15 + site.walkMinutes) * 60000,
          ).toISOString(),
        },
      ];
      await call("edit_outing", {
        outingId: outing.id,
        start,
        end,
        site,
        ...(f.has("availableFrom")
          ? {
              availability: {
                start: new Date(f.get("availableFrom")).toISOString(),
                end: new Date(f.get("homeBy")).toISOString(),
              },
            }
          : {}),
      });
      toast(
        outing.status === "draft"
          ? "Draft updated. Review it before inviting."
          : "Plan updated. Participants can review the changes.",
      );
      return showOuting(outing.id, false);
    }
    if (form.id === "cancel-form") {
      await call("cancel_outing", {
        outingId: outing.id,
        reason: f.get("reason"),
      });
      return showOuting(outing.id, false);
    }
  } catch (error) {
    const target = form.querySelector(".inline-error");
    if (target) target.textContent = error.message;
    else toast(error.message);
  } finally {
    if (form.id === "plan-form" && $("#plan-progress"))
      $("#plan-progress").textContent = "";
    if (submit?.isConnected) submit.disabled = false;
  }
});
new MutationObserver(() => {
  const input = $("#edit-site");
  if (input && !input.dataset.bound) {
    input.dataset.bound = "true";
    autocomplete(input, {
      search: (args) => call("autocomplete_address", args),
      bias: () => outing.site.location,
      onSelect: (p) => {
        input.form.selectedSite = p;
        input.form.siteUnselected = false;
      },
      onClear: () => {
        input.form.selectedSite = null;
        input.form.siteUnselected = true;
      },
    });
  }
  const meeting = $("#edit-meeting");
  if (meeting && !meeting.dataset.bound) {
    meeting.dataset.bound = "true";
    autocomplete(meeting, {
      search: (args) => call("autocomplete_address", args),
      bias: () => outing.site.location,
      onSelect: (p) => {
        meeting.form.selectedMeeting = p;
        meeting.form.meetingUnselected = false;
      },
      onClear: () => {
        meeting.form.selectedMeeting = null;
        meeting.form.meetingUnselected = Boolean(meeting.value.trim());
      },
    });
  }
}).observe(app, { childList: true, subtree: true });
window.addEventListener("popstate", () => {
  wizard = null;
  modal.replaceChildren();
  view = new URLSearchParams(location.search).get("view") || "explore";
  render().catch((e) => toast(e.message));
});
initFx();
try {
  bootstrap = await http("/api/bootstrap");
  await render();
} catch (error) {
  app.innerHTML = `<section class="panel"><h1>A small interruption.</h1><p>${esc(error.message)}</p><a href="/">Try again</a></section>`;
}
