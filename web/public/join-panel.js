import { esc } from "./shell.js";
import { autocomplete } from "./autocomplete.js";
import { locate, locationContext } from "./location.js";
const field = (label, name, type, value = "", extra = "") =>
  `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
export async function openJoin(root, { outing: o, user, call, onJoined }) {
  const options = await call("get_join_options", { outingId: o.id }),
    saved = user.preferences || {},
    time = (value) =>
      new Intl.DateTimeFormat("en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: o.timezone,
      }).format(new Date(value));
  const d = {
    name: saved.name || "",
    mode: "self",
    channel: saved.channel || "email",
    origin: saved.origin,
    pickupId: options.pickups[0]?.id,
    maxWalkMinutes: saved.maxWalkMinutes ?? 20,
    maxTravelMinutes: saved.maxTravelMinutes ?? 90,
    confirmed: false,
    car: {
      available: true,
      offerRides: true,
      passengerSeats: 2,
      maxDetourMinutes: 20,
      pickupPoints: [],
    },
  };
  let cleanup = [];
  const clean = () => {
    cleanup.forEach((fn) => fn());
    cleanup = [];
  };
  function frame(body) {
    clean();
    root.innerHTML = `<div class="modal-backdrop"><section class="panel plan-modal join-modal" role="dialog" aria-modal="true" aria-labelledby="join-title"><button class="modal-close" type="button" data-action="close-wizard" aria-label="Close">×</button><div class="eyebrow">ONE EVENING, TOGETHER</div><h2 id="join-title">Join this evening.</h2><p><strong>${esc(o.title)}</strong><br>${esc(time(o.start))} · ${esc(o.site.name)}</p>${body}</section></div>`;
  }
  function collect() {
    const form = root.querySelector("#quick-join-form");
    if (!form) return;
    const f = new FormData(form);
    d.name = f.get("name");
    d.channel = f.get("channel");
    const note = root.querySelector("#calendar-note");
    if (note)
      note.hidden = d.channel !== "calendar" || options.calendarAvailable;
    d.confirmed = f.has("confirmed");
    d.maxWalkMinutes = Number(f.get("walk") ?? d.maxWalkMinutes);
    d.maxTravelMinutes = Number(f.get("travel") ?? d.maxTravelMinutes);
    if (f.has("pickup")) d.pickupId = f.get("pickup") || undefined;
    if (f.has("seats")) {
      d.car.passengerSeats = Number(f.get("seats"));
      d.car.maxDetourMinutes = Number(f.get("detour"));
    }
    d.equipment = f.has("telescope") ? ["telescope"] : [];
    d.shareEquipment = f.has("telescope");
    d.happyToTeach = f.has("guide");
  }
  function address(selector, onSelect, onClear) {
    const input = root.querySelector(selector);
    if (!input) return;
    const context = locationContext();
    const stop = autocomplete(input, {
      search: (args, opts) => call("autocomplete_address", args, opts),
      bias: () => context.point || o.site.location,
      country: () => context.country,
      onSelect,
      onClear,
    });
    cleanup.push(stop);
    if (!context.requested)
      locate(call, root.querySelector("#join-location-status"), () => {
        if (input.isConnected && document.activeElement === input)
          stop.refresh();
      });
  }
  function render() {
    frame(`<form id="quick-join-form">${saved.name ? `<input name="name" type="hidden" value="${esc(d.name)}">` : field("What should we call you?", "name", "text", d.name, 'required maxlength="100"')}<div class="choice-grid join-travel">${[
      ["self", "I’ll make my own way"],
      ["ride", "I need a lift"],
    ]
      .map(
        ([v, l]) =>
          `<label class="choice ${d.mode === v ? "selected" : ""}"><input type="radio" name="mode" value="${v}" ${d.mode === v ? "checked" : ""}><span>${l}</span></label>`,
      )
      .join("")}</div>
    ${d.mode === "self" ? `<div class="soft-note"><strong>Meet at ${esc(o.site.name)}</strong><p>Arrive by ${esc(time(options.meeting.meetAt))}.<br>Ready to leave around ${esc(time(options.meeting.leaveAt))}.</p><small>Includes the final walk, setup and pack-up.</small></div>` : ""}
    ${d.mode === "ride" && !options.availableSeats ? '<p class="soft-note gold">No spare car seats are offered right now. You can make your own way or offer a lift.</p>' : ""}
    ${d.mode === "ride" && options.availableSeats ? `<label>Pickup<select name="pickup">${options.pickups.map((p) => `<option value="${p.id}" ${d.pickupId === p.id ? "selected" : ""}>${esc(p.point.name)} · ${esc(p.driver)} · ${p.seats} ${p.seats === 1 ? "seat" : "seats"}</option>`).join("")}<option value="" ${!d.pickupId ? "selected" : ""}>Find a pickup near my public starting point</option></select></label>${d.pickupId ? `<p>Make your own way to this pickup. We’ll check the lift from there and back.</p>${field("Maximum journey minutes each way from this pickup", "travel", "number", d.maxTravelMinutes, 'min="1" max="240" required')}${field("Maximum walking minutes at the observing site", "walk", "number", d.maxWalkMinutes, 'min="0" max="120" required')}` : `<label class="address-field">Your public starting point<input id="join-origin" value="${esc(d.origin?.name || "")}" placeholder="Station, street or town" required></label><small id="join-location-status"></small>${field("Maximum walking minutes each way", "walk", "number", d.maxWalkMinutes, 'min="0" max="120" required')}${field("Maximum journey minutes each way", "travel", "number", d.maxTravelMinutes, 'min="1" max="240" required')}`}` : ""}
    ${d.mode !== "drive" ? '<button class="text-button" type="button" id="offer-lifts">I can offer lifts instead</button>' : `<h3>Your lift offer</h3><label class="address-field">Your public starting point<input id="join-origin" value="${esc(d.origin?.name || "")}" placeholder="Station, street or town" required></label><small id="join-location-status"></small><div class="form-grid">${field("Spare seats after equipment", "seats", "number", d.car.passengerSeats, 'min="1" max="7" required')}${field("Extra driving minutes each way", "detour", "number", d.car.maxDetourMinutes, 'min="0" max="120" required')}</div>${field("Maximum journey minutes each way", "travel", "number", d.maxTravelMinutes, 'min="1" max="240" required')}${field("Maximum walking minutes at the observing site", "walk", "number", d.maxWalkMinutes, 'min="0" max="120" required')}<label class="address-field">Preferred public pickup (optional)<input id="join-driver-pickup" value="${esc(d.car.pickupPoints[0]?.name || "")}" placeholder="Station or public place"></label><small>Pickup and drop-off stops count toward your extra driving time.</small>`}
    ${options.needsTelescope ? `<label class="check-line"><input type="checkbox" name="telescope" ${d.shareEquipment ? "checked" : ""}>I can bring and share a telescope this evening</label>` : ""}${o.needsGuide ? `<label class="check-line"><input type="checkbox" name="guide" ${d.happyToTeach ? "checked" : ""}>I can help as an experienced guide</label>` : ""}
    <details class="join-notifications"><summary>Invitation preference</summary><label>Send updates by<select name="channel"><option value="email" ${d.channel === "email" ? "selected" : ""}>Email</option><option value="calendar" ${d.channel === "calendar" ? "selected" : ""}>Google Calendar</option></select></label><p id="calendar-note" class="fineprint" ${d.channel !== "calendar" || options.calendarAvailable ? "hidden" : ""}>Calendar invitations are waiting for the organizer to connect Google or send through Codex. You can join and respond here now; your Calendar preference will be kept.</p></details>
    <label class="check-line"><input type="checkbox" name="confirmed" required ${d.confirmed ? "checked" : ""}>${d.mode === "self" ? "I can arrive at the meeting time and arrange my journey home." : d.mode === "drive" ? "My car and these seats are available for the outward and return journeys." : d.pickupId ? "I can make my own way to and from the selected pickup." : "I’ll review the proposed outward and return journey before joining."}</label><p class="inline-error" id="join-error" role="alert"></p><button class="primary" type="submit" ${d.mode === "ride" && !options.availableSeats ? "disabled" : ""}>${d.mode === "self" ? "Review & join →" : "Check my lift →"}</button></form>`);
    const form = root.querySelector("form");
    form.onchange = (e) => {
      collect();
      if (e.target.name === "mode") {
        d.mode = e.target.value;
        d.confirmed = false;
        render();
      } else if (e.target.name === "pickup") {
        d.confirmed = false;
        render();
      }
    };
    root.querySelector("#offer-lifts")?.addEventListener("click", () => {
      collect();
      d.mode = "drive";
      d.confirmed = false;
      render();
    });
    address(
      "#join-origin",
      (p) => (d.origin = p),
      () => {
        delete d.origin;
      },
    );
    address(
      "#join-driver-pickup",
      (p) => (d.car.pickupPoints = [p]),
      () => {
        d.car.pickupPoints = [];
      },
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      collect();
      const b = e.submitter;
      b.disabled = true;
      try {
        const input = root.querySelector("#join-origin");
        if (input?.value.trim() && !d.origin)
          throw new Error(
            "Select your starting point from the suggestions.",
          );
        const pickup = root.querySelector("#join-driver-pickup");
        if (pickup?.value.trim() && !d.car.pickupPoints.length)
          throw new Error(
            "Select the pickup from the suggestions, or leave it blank.",
          );
        const details = {
          name: d.name,
          mode: d.mode,
          channel: d.channel,
          confirmed: d.confirmed,
          equipment: d.equipment,
          shareEquipment: d.shareEquipment,
          happyToTeach: d.happyToTeach,
        };
        if (d.mode === "ride" && d.pickupId) {
          details.pickupId = d.pickupId;
          details.maxTravelMinutes = d.maxTravelMinutes;
          details.maxWalkMinutes = d.maxWalkMinutes;
        } else if (d.mode !== "self") {
          details.origin = d.origin;
          details.maxWalkMinutes = d.maxWalkMinutes;
          details.maxTravelMinutes = d.maxTravelMinutes;
        }
        if (d.mode === "drive") details.car = d.car;
        const review = await call("preview_join", {
          outingId: o.id,
          details,
        });
        frame(
          `<div class="soft-note"><strong>${review.mode === "self" ? "Your own transport" : review.mode === "ride" ? `A lift with ${esc(review.driver.name)}` : "Your lift offer"}</strong><p>${review.mode === "self" ? `Meet at ${esc(time(review.route.meetAt))}.<br>Leave around ${esc(time(review.route.leaveAt))}. Your journey home is self-arranged.` : `${details.pickupId ? "Be at the pickup by" : "Leave"} ${esc(time(review.route.departAt))}.<br>${details.pickupId ? "Back at the pickup by" : "Home by"} ${esc(time(review.route.homeBy))}.`}</p>${review.pickup ? `<p>${esc(review.pickup.pickup.name)}<br>Pickup ${esc(time(review.pickup.pickupAt))}<br>Return ${esc(time(review.pickup.dropoffAt))}</p>` : ""}</div><p>${review.mode === "self" ? "Joining confirms your attendance and your own transport arrangements." : "Joining confirms the journey and any equipment offered above."}</p>${d.channel === "calendar" && !options.calendarAvailable ? '<p class="soft-note gold">Your place can be confirmed here. Your Calendar invitation is pending until the organizer connects Google or sends it through Codex.</p>' : ""}<p class="inline-error" id="join-error" role="alert"></p><div class="button-row"><button class="primary" id="quick-confirm">Join this evening →</button><button class="secondary" id="quick-back">Change travel details</button></div>`,
        );
        root.querySelector("#quick-back").onclick = render;
        root.querySelector("#quick-confirm").onclick = async (event) => {
          event.target.disabled = true;
          try {
            await call("join_outing", {
              outingId: o.id,
              details,
              expectedVersion: review.version,
              expectedPreview: review.previewKey,
            });
            clean();
            root.replaceChildren();
            await onJoined();
          } catch (error) {
            root.querySelector("#join-error").textContent = error.message;
            event.target.disabled = false;
          }
        };
      } catch (error) {
        root.querySelector("#join-error").textContent = error.message;
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    };
  }
  render();
}
