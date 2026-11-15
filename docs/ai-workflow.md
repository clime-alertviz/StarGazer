# Prompts and AI workflow

[Setup](../README.md) · [Example requests](../examples/requests.md)
· [Tool-call traces](../examples/README.md)

## Two ways to use the same account

| | Website | Local Codex |
| --- | --- | --- |
| Who compares and chooses? | A background Codex agent on the service machine | Codex in your current chat |
| Where are the records? | StarGazer service and SQLite | The same service and SQLite, accessed through MCP |
| Provider research | Direct Geoapify and sky tools | Direct Geoapify and sky MCP tools |
| Final validation | Shared deterministic checks | The same checks |
| Invitations | Configured server Gmail/SMTP/Calendar | Server delivery or connected Codex Gmail/Calendar |
| Backend model required? | Yes for the default agent | No |

To run the service without a backend model, set `STAR_GAZER_SOLVER=deterministic`.
This selects the original rule-based website planner; it does not replace the
reasoning performed by your local Codex chat. Local planning uses the granular
operations below, not `start_plan` or a second model.

## User prompts

**Discover:** “Use StarGazer. Find an open evening where someone can show me
Saturn. I need a lift, and I can walk up to twenty minutes to a public pickup.”

**Organize:** “Plan a quiet photography evening with my circle next week.
Look for someone happy to teach. Do the matching here in Codex, compare two
places, and save a draft for me to review. Keep remaining places open.”

**Review:** “Explain why this group and site work. Show the observing conditions,
everyone’s full journey, and any access or transport arrangements still missing.”

**Invite:** “Invite the selected people using my connected Gmail and Calendar
integrations. Use each person’s chosen invitation channel.”

**Revise:** “Move our outing to the next available evening. Check the group’s
availability and routes, show me the changes, and update the same event.”

## The planning loop

1. `get_state` reads the signed-in account, preferences and circle.
2. `begin_planning` freezes the submitted evening and constraints for this run.
   The organizer's confirmed dates override their saved slots for this outing.
3. Codex calls Geoapify `list_place_categories`, `search_places`,
   `calculate_route_matrix` and `calculate_route` to investigate places and trips.
   `geocode_address` resolves named starting points when needed.
4. `get_weather_forecast` and `calculate_astronomy` supply forecast hours,
   darkness, target altitude and Moon conditions.
5. `register_planning_site` records a researched candidate with its provenance.
   A mapped park/viewpoint is not automatically approved for night access.
6. Codex proposes concrete people, site, time and travel methods to
   `check_plan_candidate`. Failed checks return constraints to investigate.
7. Codex compares checked candidates and calls `save_plan_candidate` with its
   choice and explanation. Only a checked proposal can be persisted.
8. The organizer reviews the draft, verifies access and uses `invite_outing`.

Shared code enforces capacity, equipment, seats, walking/extra-driving limits,
availability, setup, pack-up, both journeys, weather and astronomy. The model
can investigate a different combination, but cannot waive those limits.
A profile change during planning invalidates the prepared snapshot.

For existing outings, `list_outing_candidates` gives local Codex authorized
records to rank itself. `preview_join` checks the journey; `join_outing`
commits the reviewed version and preview key. It requests another review if the
journey changes between those steps.

## Invitations from local Codex

Follow the [connector delivery procedure](../skills/star-gazer/references/connector-delivery.md).
Select `codex` delivery before inviting; claim each prepared delivery, send using
the connected integration, then record its real provider ID. The service excludes
claimed Codex deliveries from its own sender. Updates reuse the event ID;
cancellations cancel that event. Uncertain results are reconciled before retrying.

The connector account must match the organizer. Later changes wait for Codex to
process them, unless delivery is switched to a configured server sender. Sign-in
and circle messages remain server mail or the local outbox.

## Remote access and sign-in

`STAR_GAZER_URL` can be a hosted service instead of localhost. Its MCP supports
remote profile changes, new outing creation, responses and coordination. SQLite
stays on the service; the plugin does not download the database or server secrets.

- `POST /auth/request`, JSON `{"email":"you@example.com"}`, requests a sign-in link.
  Browser requests include an `Origin` matching the service URL.
- Unauthenticated `POST /mcp` exposes only `request_signin`.
- Open the email link and click **Continue**, then create an MCP token in Settings.
- Authenticated MCP calls use `Authorization: Bearer <token>`; browser sessions
  use an HttpOnly cookie and CSRF protection. Tokens expire after 90 days.

## Prompts and corrections used while building

The project was developed iteratively with Codex. Representative requests from
the project conversation, with private details omitted:

- “Build and test [the trimmed specification] … Make everything clean and simple.”
- “The webapp is just nice GUI to it.”
- “Include multiple slots and weekly recurrence now.”
- “I want LLM to do matching / constraint solving … keep the original logic intact
  and implement this as a separate solver backend … used by default.”
- “Local Codex should also be able to send emails … through the integrations.”
- “What we see should be what we get always.”

The working cycle was: clarify the journey → implement UI and shared operations
→ exercise the real browser → reproduce failures → add focused regression tests
→ run local/background model checks → record redacted traces. User feedback
separated short joining from full planning, made availability authoritative, and
kept independent provider tools accessible to the local agent.

The exact agent instructions live in [the StarGazer skill](../skills/star-gazer/SKILL.md).
The background prompt is in [the Codex solver](../web/server/solvers/codex.js);
[the local-client check](../scripts/verify-client-solver.js) includes its runnable
prompt. The evidence files label real model calls, fixture inputs and live
provider calls separately.
