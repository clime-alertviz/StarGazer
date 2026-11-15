# Verification

Latest submission check: **16 November 2026**, version **0.4.0**.
All **179 automated tests** pass, as do manifest/configuration checks and the
submission check for required files, links, media and local-secret exclusion.
The installed plugin exposes 41 StarGazer operations, five Geoapify tools and two
weather/astronomy tools. Both Codex planning paths have executed successfully.

The current walkthrough is [included in the repository](showcase.mp4): 68.5 seconds,
1920 × 1080 at 30 fps, English narration/captions, original music and effects.
The public submission is identified by the v0.4.0 tag; see the release page.

## Earlier verification baseline (15 November 2026)

The following table records the earlier baseline; later sections document the
additional regressions and live checks leading to the current result.

| Check | Result |
| --- | --- |
| Automated suite | **157 tests passed**, zero failures or skipped tests. |
| Plugin and skill | Manifest/configuration checks and skill validation passed. |
| Installed package | The installed stdio adapter called the authenticated HTTP MCP service; all 27 tools were discovered. Account identity, connection test, comment and cancellation used the same SQLite records. |
| Recurring availability | Multiple slots, overnight windows, weekly recurrence and DST behavior tested. |
| Capacity and transport | Concurrent joins cannot take the same last place; pending and Maybe reservations expire; seats, pickups, walking, setup and return travel are enforced. |
| Lifecycle | Deadlines begin with invitations, replacement guests can be invited, declined people do not block edits, and needs-review outings close after their end. |
| Calendar recovery | Fixtures cover uncertain writes, a cancellation arriving during an update, actual DELETE requests, preserved event IDs, overlapping reads, and revision-aware reconfirmation. |
| Email | SMTP sent a composed invitation to a real local TCP mail sink. Gmail MIME composition and API requests were checked with a provider fixture. |
| Authentication | Scanner-safe sign-in, first account creation, return to the invited page, CSRF/Origin checks, token expiry/revocation and uniform rate-limit responses tested. |
| OAuth | Fixture checks cover PKCE, one-use state, verified identity and secret-free errors. The main local instance also completed real Google authorization and stored an encrypted grant. |
| Live Calendar access | The server's own OAuth provider read the preserved connection-test event from Google and returned the guest's accepted status. |
| Persistence and migration | Restart persistence tested. A copy of the existing local database migrated without notifications or duplicate records; the previously accepted Calendar test retained its event ID. Original records were backed up before switching the main service. |
| Deterministic planner | `npm run demo` passed independent-travel, carpool, missing-telescope and insufficient-seat cases. |

## Browser walkthrough

The browser was checked at its desktop size and at 390 × 844 pixels. Verification
covered:

- Email sign-in through the local outbox and an explicit confirmation click.
- Avatar selection, live address autocomplete, keyboard selection, multiple
  availability slots, weekly recurrence, broad interests and flexible travel.
- Back navigation preserving the entered answers without losing authentication.
- Progressive outing suggestions, live Geoapify route validation, a private
  journey preview, joining, declining and rejoining an available place.
- Driver and passenger pickup/return times, astronomy and weather reports.
- A participant circle invitation accepted by the other account, producing mutual
  membership; a comment and its correctly nested reply.
- Creating a local email connection test from Settings, editing it to a four-hour
  window, requiring reconfirmation and cancelling it.
- Shared navigation/branding, mobile layout, provider instructions and absence
  of browser console errors during the final walkthrough.

The extra debugging pass fixed out-of-order Calendar reads, cancellation queued
during a write, Maybe reservations holding places indefinitely, organizer capacity,
solo recommendations overlooking compatible friends, recovery of imported events,
missing driver alerts, and late acceptances after a proposed departure. Navigation now includes pickup stops for drivers and
walking directions to the passenger's pickup.

## What is real and what is simulated

The final browser join and autocomplete used **live Geoapify** requests. The
sample community uses fixture weather/access records and calculated astronomy;
fixture weather is not a current forecast. Normal planning and the organizer’s
Refresh weather action call Open-Meteo. The original live weather, astronomy,
routing and planner traces remain available under `examples/generated`.

**Google OAuth is connected on the main local instance.** Calendar and Gmail APIs
are enabled, the four owner-controlled test accounts are registered, and callbacks
for ports 4317 and 4318 are configured. The account grant belongs to the main
instance; another instance requires its own connection through Settings.

The new server's provider successfully read the earlier connection-test event and
its accepted guest response using the newly authorized account. That response was
originally submitted through the previous connector; it verifies current read
access, not a new invitation/RSVP round trip. New Calendar writes, cancellation and
real Gmail delivery still need a live test through this connection. Gmail sending
permission is granted; SMTP is not configured, so system sign-in messages continue
to use the local outbox. See [provider setup](providers.md).

No public hosting was performed. A localhost invitation link opens on the machine
running the app; Calendar responses can still be submitted from another device.

## Reproduce

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run demo
npm run package
codex plugin marketplace add ./output/marketplace
codex plugin add star-gazer@star-gazer-local
npm run verify:install
```

`verify:install` creates an isolated local service and passes its temporary token
to the installed adapter in memory. It does not use a personal Google account.
The redacted [shared-service MCP trace](../examples/generated/community-mcp-trace.json)
contains its example request and tool results.

To repeat the GUI flow, use the [walkthrough](walkthrough.md) and the separate
`private/community-demo` database. Run only one service per database. The README
lists supported targets, group/search limits and the distinction between
approximate traffic and live traffic prediction.

## Public browsing check

The signed-out homepage and open outing previews were checked on desktop and at
390px mobile width. Personal navigation is absent before sign-in; account settings
remain in the top-right control after sign-in. The browser flow from an open
outing through local email sign-in returned to that same outing. Browser logs
contained no errors. HTTP regression coverage checks private, draft, closed,
past and full outings, limits preview fields, preserves sign-in destinations and
rejects anonymous joining.

## Join, creation and traffic debugging pass

- A new account completed the compact self-transport join and released its test
  place. No profile wizard, home address or availability survey was required.
- Flat Settings preferences saved successfully; checked at desktop and 390px.
- Live autocomplete resolved `Zlata Hora, Slavkov u Brna` to the correct street.
- The browser created a new open draft near Slavkov with no circle and no driver.
  The draft had live weather and calculated astronomy, an explicit Driver needed
  state and unverified access. It was not published.
- A car outing displayed outward/return estimates from real Geoapify MCP calls
  using both approximated and free-flow traffic. Driverless reports are omitted.
- Regression tests cover pending-driver capacity, rider reconfirmation, partial
  profiles, selected pickups, route caching, missing estimates and private
  coordinates. Self-transport preserves others' routes without new provider calls.

Walking-only and bicycle-only outings were explicitly tested: both confirm
without a driver and make no traffic calls. First-time planning has no preselected
travel mode; remembered choices remain editable.

## Claude review regression pass

The follow-up pass used isolated databases and provider fixtures. It checked:

- Malformed `GET //` returns 400 and the server remains responsive.
- A replacement driver can repair a broken lift. Affected passengers and drivers
  must confirm changed journeys; deadline-only edits preserve reviewed routes.
- Older v0.2 and v0.3 outings retain Calendar IDs and pause automatic processing.
  Repeated migration and background delivery produce no import notifications.
- Draft visibility and cancellation, saved-profile preservation, driver-only
  capacity, unsuitable conditions, late Maybe responses and organizer declines.
- Missing Google authorization, five-attempt Calendar retry limits, deleted-event
  handling, SMTP fallback and hosted startup without sign-in email.
- Sign-in alias/client limits, expired-link cleanup and comment sender
  identity. Declined people cannot read discussions or post new comments.
- Weekly availability and compact joins across clock changes. Ambiguous times use
  the earlier occurrence; missing times move forward by the clock-change gap. A
  gap that eliminates a short window omits that occurrence, preserving later weeks.
- The seed command ignores the main database setting.

The browser pass verified opening a suggestion from both an early wizard step and
the last step, then checked that name, interests, note, equipment, public starting
point, travel and weekly availability remained in Settings. It also verified the
car-availability error, immediate display of car/recurrence fields, useful initial
focus and autocomplete selection. Browser logs contained no warnings or errors.
Address suggestions in this follow-up pass used a fixture; the earlier live
Geoapify checks above remain separate evidence.

`npm run check`, the deterministic demo, package build and installed MCP adapter
check also passed. External-key storage hardening from review point 22 was deferred;
the existing local encryption-key arrangement is unchanged.

The sign-in follow-up removed the shared quota. Regression tests simulate one
client exhausting 100 hourly emails while another client still signs in, concurrent
requests, cooldown expiry, and separate users behind the same trusted proxy. HTTP
checks verify 429/`Retry-After`, that blocked requests queue no email, and that
forged forwarded headers cannot bypass client limits. IPv4, IPv6, CIDR trust and
multi-proxy chains are covered. See [proxy setup](providers.md#sign-in-limits-and-reverse-proxies).

The avatar selector was also checked on opening, after Back navigation, and with
mouse/arrow-key changes: exactly one avatar stays selected. Initial focus goes to
the name field; keyboard focus has a separate dashed mint outline.

The planning follow-up passes all 148 tests. Regressions cover short inherited
slots, overnight defaults, reversed dates, insufficient observing/preparation
time, the seven-day limit, and organizer-specific dates surviving route checks
without changing profile availability. Browsing other dates continues to hide
private and unsuitable outings. Validation happens before provider requests.

Browser checks on an isolated fixture verified the midnight error, the 24-hour
date summary, closing/reopening at the same wizard step, restoring edited values
on the final form, clearing unfinished progress on reload, and creating a walking
outing with astronomy, weather and a journey within the selected evening.
The main local database was backed up and populated with the eight sample
outings; four suitable open outings with places were visible on its homepage.
The package build and installed 24-tool MCP adapter check also passed.

## Codex solver backend

The default backend now runs real Codex turns for proposal construction and
semantic matching. The original deterministic planner remains selectable and its
existing regression suite still passes. The full suite contains 157 passing tests.
New checks cover the agent choosing a validated alternative, choosing circle
members and an offered travel mode, guide constraints, invented IDs, unauthorized
people, invalid journey times, cancellation, explicit failures without fallback,
matching cache behavior, and authenticated HTTP planning jobs.

`npm run test:live-solver` passed with the real Codex model. It chose a photography
teacher from two circle candidates, compared two sites, checked complete journeys
and saved one draft. A second model turn ranked a quiet photography outing above
a lively social evening using the profile's free-text preference. The
[recorded trace](../examples/generated/solver-live-check.json) includes the actual
tool choices and result. Astronomy Engine was real; weather and Geoapify routes
were fixtures in a temporary database. This verifies model orchestration and
constraint enforcement, not live conditions at those places.

The isolated browser pass verified the default Codex selection, pending and
completed matching reasons, planning progress, closing/reopening during a run,
stopping, retrying with preserved answers, and the resulting **Why this plan**
section with seven tool checks. The browser had no warnings or errors.
The debugging pass also avoids repeatedly rebuilding the discovery page when a
poll returns unchanged results, preserving focus while matching continues.

## Local Codex and website parity

The final suite passes **166 tests**. Client-led HTTP MCP planning is tested with
a backend runtime that throws if called. Actual Codex reads the eligible profiles,
compares two candidates, selects the photography teacher and saves a draft with
`execution: client`; the backend model call count is zero. The separate real
website-agent test also passes. Both use real Astronomy Engine calculations and
fixture weather/routes in temporary databases, with no external send provider.

- [Client reasoning trace](../examples/generated/client-solver-live-check.json)
- [Website agent trace](../examples/generated/solver-live-check.json)

Delivery tests cover server-managed Calendar creation, pending Google connection,
and client-managed email/Calendar claims, receipts, updates and cancellation of
the same event. They verify that the server sends none of the client-owned work,
that uncertain claims survive a database reload, and that a new attempt requires
explicit reconciliation. Fresh Calendar responses import through the same rules.
The new connector handoff was tested with provider fixtures; actual Gmail/Calendar
writes through Codex's connected tools were not exercised in this pass.

The browser pass verified stable wizard dimensions before/after suggestions,
independent scrolling in both columns, the create action above suggestions, and
a 390 × 844 mobile layout. Google Calendar is selectable without a connected
organizer; a successful join retains it and displays pending delivery. A five-minute
ride limit produced a specific 21-minute journey error in the fixture, then the
same pickup joined successfully after increasing the limit. A separate live
Geoapify check reproduced the reported Kozákov journey at roughly 120 minutes each
way against a saved 60-minute limit; it passed with a sufficient explicit limit.

The installed plugin exposes **40 tools** through its stdio-to-HTTP adapter.
Unauthenticated MCP exposes only email sign-in; private operations return 401.
Both local services were backed up and restarted; each homepage exposes four
upcoming open outings. Public data and account data remain separate.

## Independent provider tools

The final suite passes **172 tests**. The installed plugin exposes three MCP
servers: 41 StarGazer tools, five individual Geoapify tools and two weather/astronomy
tools. The provider servers work without a StarGazer account, database or backend
model. The installation check exercises the installed sky calculation as well as
the shared-service adapter.

Both real Codex planning checks passed with individual provider calls. Local
Codex researched and registered two sites, compared checked proposals and saved
a draft; backend model calls remained zero. The website's background agent used
the same provider operations and chose a validated draft. These checks use
fixture weather/routes, real Astronomy Engine and temporary databases. The
existing-outing ranking path also exposes the provider tools, with an eight-call
research limit and no invitation operations.

Separately, `npm run test:live-providers` exercised all seven provider tools through
the standalone MCP processes against live Geoapify and Open-Meteo, plus real
Astronomy Engine. It found two viewpoints near Slavkov u Brna and obtained routes,
a matrix, hourly weather and sky positions. See the
[provider trace](../examples/generated/providers-live-check.json).
This check uses no StarGazer database, token or backend LLM.

Regression checks cover missing credentials, explicit units, incomplete forecast
coverage, invalid date ranges, registering researched sites,
and keeping unverified night access from being treated as confirmed. No real
email or Calendar writes were needed for this provider-tool change.

## Form and saved-preference consistency

The suite passes **179 tests** after auditing creation, discovery, joining,
editing, Calendar payloads and both Codex entry points. New regressions cover:

- A saved 19:00–19:30 slot cannot replace the submitted 19:00–01:00 evening in
  the model context or validation. Other participants keep their own availability.
- An open organizer-only draft retains its requested minimum for confirmation.
- Background planning and local Codex both reject profiles changed during a run.
- Cleared or omitted fields in a supplied discovery snapshot do not inherit old
  profile values or invented defaults before reaching the matching agent.
- A changed route after a join preview requires a new review; explicit invitation
  and equipment choices govern that outing without replacing profile defaults.
- Edits accept an explicit organizer availability window and retain others' limits.
- Calendar and page descriptions use the same current outing equipment, pickup
  names and local times. Walking/cycling outings expose no driving-traffic text.

The reported form was retried in Chrome using the actual Codex agent, live
Geoapify routes, live Open-Meteo and Astronomy Engine. With its unchanged choices,
it saved a walking draft at Park A. B. Svojsíka for 17 November 2026, 20:00–21:00
Europe/Prague, departure 19:35 and home by 21:25. The chosen routes were ten minutes
each way, within the twenty-minute walking limit and the submitted six-hour evening.
Night access remains unverified. The draft is private until the organizer reviews
access and opens it. This was a complete live planning check, not fixture weather
or routes.

Browser checks also verified that editing the draft without changing its values
preserves the journey, Escape restores the wizard's current step and unsaved
answers, and the join review preserves the displayed meeting/departure times and
allows Calendar selection. That review was closed before joining. The local
Codex client check passed again with zero backend model calls; its provider data
is isolated fixture data, as described above.
