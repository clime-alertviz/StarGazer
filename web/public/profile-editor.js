import { esc } from "./shell.js";
import { autocomplete } from "./autocomplete.js";
import { locate, locationContext } from "./location.js";
const field = (label, name, type, value = "", extra = "") =>
  `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const choices = (name, values, selected = []) =>
  values
    .map(
      ([v, l]) =>
        `<label class="check-line"><input type="checkbox" name="${name}" value="${v}" ${selected.includes(v) ? "checked" : ""}>${l}</label>`,
    )
    .join("");
export function mountProfile(root, { profile, email, call, onSaved }) {
  const p = structuredClone(profile || {});
  p.slots ||= [];
  let cleanup;
  function collect() {
    const form = root.querySelector("form");
    if (!form) return;
    const f = new FormData(form);
    Object.assign(p, {
      name: f.get("name"),
      avatar: f.get("avatar"),
      channel: f.get("channel"),
      timezone: f.get("timezone"),
      interests: f.getAll("interests"),
      interestNote: f.get("note"),
      experience: f.get("experience"),
      happyToTeach: f.has("teach"),
      equipment: f.getAll("equipment"),
      shareEquipment: f.has("share"),
      travel: f.getAll("travel"),
      maxWalkMinutes: Number(f.get("walk")),
      maxTravelMinutes: Number(f.get("journey")),
    });
    p.slots = p.slots.map((slot, i) => ({
      date: f.get(`date-${i}`),
      from: f.get(`from-${i}`),
      until: f.get(`until-${i}`),
      weekly: f.has(`weekly-${i}`),
      ...(f.get(`through-${i}`) ? { through: f.get(`through-${i}`) } : {}),
    }));
  }
  function render() {
    cleanup?.();
    root.innerHTML = `<form id="profile-form" class="profile-form"><section class="panel"><h2>About you</h2><p class="muted">${esc(email)}</p><div class="form-grid">${field("Name", "name", "text", p.name || "", 'required maxlength="100"')}<label>Avatar<select name="avatar">${["star", "saturn", "moon", "comet"].map((v) => `<option ${p.avatar === v ? "selected" : ""}>${v}</option>`).join("")}</select></label><label>Invitations<select name="channel"><option value="email" ${p.channel !== "calendar" ? "selected" : ""}>Email</option><option value="calendar" ${p.channel === "calendar" ? "selected" : ""}>Google Calendar</option></select></label>${field("Timezone", "timezone", "text", p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, "required")}</div></section>
    <section class="panel"><h2>Your interests</h2><div class="preferences-checks">${choices(
      "interests",
      [
        "Planets",
        "Stargazing",
        "Photography",
        "Learning",
        "Social evenings",
        "Open to anything",
      ].map((v) => [v, v]),
      p.interests,
    )}</div><label>Anything else?<textarea name="note" maxlength="1000">${esc(p.interestNote || "")}</textarea></label><label>Experience<select name="experience"><option value="beginner" ${p.experience !== "experienced" ? "selected" : ""}>Curious beginner</option><option value="experienced" ${p.experience === "experienced" ? "selected" : ""}>Experienced observer</option></select></label><label class="check-line"><input name="teach" type="checkbox" ${p.happyToTeach ? "checked" : ""}>I’m happy to help others learn</label></section>
    <section class="panel"><h2>Equipment</h2><div class="preferences-checks">${choices(
      "equipment",
      [
        ["telescope", "Telescope"],
        ["binoculars", "Binoculars"],
        ["camera", "Camera"],
        ["tripod", "Tripod"],
      ],
      p.equipment,
    )}</div><label class="check-line"><input name="share" type="checkbox" ${p.shareEquipment ? "checked" : ""}>I’m usually happy to share</label><small>You confirm what you will bring for each evening.</small></section>
    <section class="panel"><h2>Usual travel preferences</h2><label class="address-field">Public starting point (optional)<input id="profile-origin" value="${esc(p.origin?.name || "")}" placeholder="Street, town or public place"></label><small id="profile-location-status"></small><div class="preferences-checks">${choices(
      "travel",
      [
        ["drive", "Driving"],
        ["ride", "Getting a lift"],
        ["bicycle", "Bicycle"],
        ["walk", "Walking"],
      ],
      p.travel,
    )}</div><div class="form-grid">${field("Usual walking limit, minutes each way", "walk", "number", p.maxWalkMinutes ?? 20, 'min="0" max="120" required')}${field("Usual journey limit, minutes each way", "journey", "number", p.maxTravelMinutes ?? 60, 'min="1" max="240" required')}</div><small>Car availability and spare seats are confirmed for a particular outing.</small></section>
    <section class="panel"><h2>Usual availability</h2><p>Optional defaults for future planning.</p>${p.slots.map((slot, i) => `<fieldset class="slot"><legend>Evening ${i + 1}</legend><div class="slot-inputs">${field("Date", `date-${i}`, "date", slot.date, "required")}${field("Free from", `from-${i}`, "time", slot.from, "required")}${field("Home by", `until-${i}`, "time", slot.until, "required")}</div><label class="check-line"><input type="checkbox" name="weekly-${i}" ${slot.weekly ? "checked" : ""}>Repeat each week</label>${field("Repeat through (optional)", `through-${i}`, "date", slot.through || "")}<button type="button" class="secondary" data-remove="${i}">Remove evening</button></fieldset>`).join("")}<button type="button" class="secondary" id="profile-add">Add an evening</button></section><div class="profile-save"><p id="profile-error" role="alert" class="inline-error"></p><button class="primary" type="submit">Save changes</button></div></form>`;
    const input = root.querySelector("#profile-origin"),
      context = locationContext();
    cleanup = autocomplete(input, {
      search: (args, opts) => call("autocomplete_address", args, opts),
      bias: () => context.point,
      country: () => context.country,
      onSelect: (point) => {
        p.origin = point;
      },
      onClear: () => {
        delete p.origin;
      },
    });
    input.addEventListener(
      "focus",
      () => {
        if (!context.requested)
          locate(call, root.querySelector("#profile-location-status"), () => {
            if (document.activeElement === input) cleanup.refresh();
          });
      },
      { once: true },
    );
    root.querySelector("#profile-add").onclick = () => {
      collect();
      if (p.slots.length >= 12) return;
      p.slots.push({
        date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
        from: "18:00",
        until: "02:00",
        weekly: false,
      });
      render();
    };
    root.querySelectorAll("[data-remove]").forEach(
      (b) =>
        (b.onclick = () => {
          collect();
          p.slots.splice(Number(b.dataset.remove), 1);
          render();
        }),
    );
    root.querySelector("form").onsubmit = async (e) => {
      e.preventDefault();
      collect();
      const b = e.submitter;
      b.disabled = true;
      try {
        if (input.value.trim() && !p.origin)
          throw new Error(
            "Select your starting point from the suggestions, or leave it blank.",
          );
        const data = structuredClone(p);
        if (!data.slots.length) delete data.slots;
        if (!data.travel.length) delete data.travel;
        await call("save_preferences", data);
        await onSaved();
      } catch (error) {
        root.querySelector("#profile-error").textContent = error.message;
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    };
  }
  render();
  return () => cleanup?.();
}
