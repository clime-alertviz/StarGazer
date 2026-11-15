# Web app

The current web entry point is `web/hub.js`; run `npm run web`.
The browser and Codex package share authenticated tools at `/mcp`. The website
uses background planning jobs; local Codex can call the granular candidate tools
and supply its own reasoning without that background model.
Signed-out visitors can browse upcoming open outings through read-only
`/api/public-outings` previews. These expose the public time, site, remaining
capacity and sky report; they omit participants, pickup points, comments,
preferences and Calendar details. Private, draft and closed outings have no public
preview. Joining and all changes still require authentication through `/mcp`.

Personal navigation appears only after sign-in. Settings live in the top-right
button. Joining returns visitors to the chosen outing after email sign-in;
organizing continues into the evening setup. **Plan your next adventure** opens
that flow; **Create outing** creates a draft using weather, astronomy and nearby
sites, not a search of existing outings. Joining uses a separate compact form:
self-transport, a public pickup, or an optional lift offer. Reusable preferences
have a flat editor under **Settings → Profile & preferences**.

The creation form defaults to the Codex solver. `start_plan` returns a background
job; `get_plan_job` reports tool progress and the resulting draft, and
`cancel_plan_job` stops it. Closing the form keeps the job running; reopening
restores its fields and progress. Inputs stay locked during a run. The organizer
can read the agent's explanation and checked-tool trace under **Why this plan**.
The original rule-based planner is an explicit alternative in the same form.
See [the solver design](solvers.md) for model setup, matching and limits.

Autocomplete waits 250 ms, cancels stale browser requests and caches repeated
backend searches. The browser's native location permission supplies an optional
nearby bias. It does not save device coordinates as the profile's starting point;
the user selects a suggestion. Type a town with the street if location is denied.

Walking and cycling outings do not require a driver. First-time planning asks
for an explicit travel choice; it does not preselect getting a lift.
Open drafts with a passenger who needs a lift may recruit a missing driver. They reserve room for that driver and
cannot confirm until transport is resolved and the passenger reviews the new
ride. Self-transport takes no seat and does not recalculate other people's trips.

**Expected traffic situation** appears only with an active driver. The backend
uses Geoapify MCP `calculate_route` with `approximated` and `free_flow` for both
directions, including pickups; results are cached for 15 minutes by the actual
route. No browser request exposes the Geoapify key or other people's origins.
The comparison excludes waiting and buffers and is not live or departure-time
traffic prediction. Failed estimates display Unavailable, never zero delay.

- `web/server/community.js`: profiles, circles, offers, capacity and outing actions.
- `web/server/solvers/`: interchangeable Codex and deterministic planners, matching and jobs.
- `web/server/availability.js`: dated slots, weekly recurrence and timezone handling.
- `web/server/identity.js`: email sign-in, sessions and revocable MCP tokens.
- `web/server/providers.js`: SMTP, Google OAuth, encrypted grants and provider calls.
- `web/server/delivery.js`: durable delivery, Calendar reconciliation and RSVP reads.
- `web/server/migrate.js`: preserves older outings and their existing Calendar IDs.
- `web/public/hub.js`: guided setup, discovery, circle and shared outing pages.

The HTTP service defaults to loopback. Cookies are HttpOnly and SameSite=Lax;
HTTPS deployments use Secure cookies. Browser writes require same-origin requests
and a session CSRF token. Codex uses a revocable bearer token. Both resolve to the
same user and server-side permissions. The Geoapify key never reaches the browser.

The original local prototype remains in `web/server.js` for regression coverage
and `npm run web:legacy`; it is not the new app’s entry point. Do not run two
processes against one SQLite database.

See [README](../README.md), [walkthrough](walkthrough.md) and
[provider setup](providers.md) for the current user-facing instructions.
