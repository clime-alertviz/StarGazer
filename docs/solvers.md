# Matching and planning backends

The website defaults to a **background Codex agent**. Local Codex is a second,
independent reasoning entry point: it calls granular HTTP MCP tools itself and
never needs the backend LLM. Both paths use the same data and hard checks.

## Local client reasoning

The StarGazer skill uses `list_outing_candidates` for data-only discovery and
`begin_planning` for profiles and requirements. Local Codex then calls the
independent Geoapify MCP tools and the sky MCP's `get_weather_forecast` and
`calculate_astronomy`. It can research places, compare matrices, inspect detailed
routes and calculate conditions at arbitrary public coordinates.

`register_planning_site` adds a researched candidate without claiming verified
night access or measured light pollution. `check_plan_candidate` checks the
client's exact group/site/time/travel choices. `save_plan_candidate` commits its
validated choice with the client's explanation. No second model runs. The existing
`find_planning_sites`/`inspect_planning_conditions` wrappers remain conveniences.
A session lasts 20 minutes, belongs to one account, and rejects stale profile or
circle changes at commit. Save is idempotent within the session.

The service can run with `STAR_GAZER_SOLVER=deterministic` and no Codex login;
this does not change the client-led tools. The setting controls website planning
and background discovery only. Client result metadata has `execution: client`;
background result metadata has `execution: server`.

## Website background reasoning

## What the agent does

For a new outing, the LLM reads the organizer's wishes and eligible circle
profiles, including free-text interests. It discovers candidate places through
Geoapify, inspects forecast and astronomy windows, and proposes exact combinations
of people, place, observing time and offered travel modes. It can revise a failed
proposal, compare alternatives and select the candidate it considers the best fit.

Both agents receive effective availability windows. The organizer's submitted
Available from/Home by replaces their saved slots for this outing; other people's
availability still comes from their profiles. Saved preferences are unchanged.
The context also provides a travel-based search radius and suggests nearby parks
alongside viewpoints. Route checks include both directions and the final walk.
For open outings, the minimum group is a confirmation requirement: a draft can
start with just the organizer while keeping places open for future participants.

The agent receives the five individual Geoapify tools, two sky tools, and
`read_planning_context`, `register_site`, `discover_sites`, `inspect_conditions`,
`evaluate_candidate`, and `finish_plan`. It cannot send
invitations or change preferences through these tools. `finish_plan` accepts only
an ID previously returned by the validator. The organizer sees the explanation
and tool trace under **Why this plan**; these are not private model reasoning.

Shared deterministic code checks availability, both journeys, seats, walking,
pickup/detour limits, equipment, setup/pack-up, forecast and astronomical
conditions. A candidate that fails cannot become a valid plan merely because the
model says it works. An open draft can explicitly retain missing resources under
the existing rules; access and missing arrangements must be resolved before the
outing can be published or confirmed as appropriate.

For discovery, existing permissions and filters produce eligible open outings.
The LLM ranks them using the person's preferences and adds a short reason. The
initial order stays visible while matching runs; pending and failed states are
labelled. Joining still checks current journeys and capacity. Anonymous browsing
does not invoke the LLM.

## Setup and alternatives

`npm ci --ignore-scripts` installs the pinned Codex CLI. Run `npx codex login` on
the machine running the server, unless that operating-system account is already
signed in. StarGazer starts [Codex app-server](https://learn.chatgpt.com/docs/app-server)
on demand through the existing bridge. It uses that account's Codex access and
usage allowance. No separate OpenAI API key is required for this login flow.

Optional environment settings:

| Setting | Meaning |
| --- | --- |
| `STAR_GAZER_SOLVER=codex` | Default agent backend. |
| `STAR_GAZER_SOLVER=deterministic` | Original rule-based planning and discovery ordering. |
| `STAR_GAZER_MODEL` | Override the configured Codex model. |
| `STAR_GAZER_CODEX_BIN` | Override the Codex CLI executable. |

The creation form also offers **Plan with → Rule-based planner**, and MCP planning
accepts `solver: "deterministic"` per request. The original search is preserved in
`web/server/solvers/deterministic.js`; shared checks remain in `src/planner.js` and
`src/transport.js`. There is no silent fallback after a model failure.

For hosted website agent use, install and authorize Codex on that server, or
choose the deterministic backend. Client-led planning needs no backend model. It does not inherit each visitor's browser or Codex
login. Google and mail provider authorization remains separate from the solver.

## Progress and limits

`start_plan` starts a job and returns its `id`; pass this as `jobId` to
`get_plan_job` or `cancel_plan_job`. The GUI polls progress and allows stopping a
run. Closing the form preserves it and the running job until reload. A successful
run saves one draft; invitations remain a later action. Cancellation prevents a
subsequent draft commit. A job already committing cannot be cancelled.

Jobs and ranking caches are in memory. Server restarts stop unfinished jobs;
completed drafts and their explanations remain in SQLite. Identical active
requests reuse the same job. There is one active planning job per user and a
bounded runtime queue. Discovery is debounced, cancels superseded work and caches
identical rankings for ten minutes (failed rankings for one minute).

The background agent has a four-minute turn limit and 48 planning tool calls,
including provider research. Client planning sessions permit 48 StarGazer
session operations; their separate provider calls are controlled by the client. It does not
prove a globally optimal solution or exhaust every combination. A no-match
explanation describes the tested options. Existing limits still apply: at most
eight people in a proposal, up to seven selected circle members, seven-day date
ranges, and dates within the forecast horizon. Network and model speed affect
latency. The model's explanation is advisory; the stored routes and reports are
the checked evidence.

## Verify

`npm test` runs isolated regression tests with a controllable model fixture,
including rejected candidates, circle membership, explicit backend choice,
cancellation, matching and HTTP MCP jobs. `npm run test:live-solver` uses the real
Codex model and Astronomy Engine with fixture weather/routes in a temporary
database. It writes a redacted trace to
`examples/generated/solver-live-check.json`. No production database or delivery
provider is used by that command.

`npm run test:live-client` exercises actual client-side Codex reasoning through
HTTP MCP while the service's model throws if invoked. It compares plans, selects
a compatible teacher, saves a draft, and verifies zero backend model calls.
Its redacted trace is `examples/generated/client-solver-live-check.json`.

## Provider wiring

`.mcp.json` installs `geoapify` and `star_gazer_sky` separately from `star_gazer`.
`src/provider-server.js` exposes each group over stdio. Both it and the website
background agent use `src/providers/tools.js`, so schemas/behavior stay aligned.
The checked-in Geoapify definitions were retrieved from its live `tools/list`;
individual calls pass unchanged to the actual Geoapify MCP endpoint. The final
validator uses its own provider clients and does not trust supplied result values.

The sky tools return explicit units and source/check timestamps. Missing forecast
hours are marked incomplete. Forecast ranges are at most seven days within the
fifteen-day horizon; astronomy ranges are at most two days per call with 15-minute
samples. Astronomy operates independently of forecast/network availability.

`npm run test:live-providers` checks all seven tools through standalone MCP
processes against live Geoapify/Open-Meteo and real Astronomy Engine. No database,
StarGazer access token or backend model is involved in those calls.
