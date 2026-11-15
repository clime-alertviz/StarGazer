# Requests and tool-call evidence

Start with [example requests](requests.md) and the [AI workflow](../docs/ai-workflow.md).
The recordings below are executed checks, not invented conversations.
Dates and results describe the recorded run, not a forecast for today.

| File | What it demonstrates | Reproduce |
| --- | --- | --- |
| [client-solver-live-check.json](generated/client-solver-live-check.json) | Actual local Codex researches and compares candidates, then saves one; backend model calls remain zero. Fixture routes/weather, real astronomy. | `npm run test:live-client` |
| [solver-live-check.json](generated/solver-live-check.json) | Actual website background Codex chooses and checks a proposal. Fixture providers and isolated database. | `npm run test:live-solver` |
| [providers-live-check.json](generated/providers-live-check.json) | Seven independent tools against live Geoapify/Open-Meteo and real Astronomy Engine. | `npm run test:live-providers` |
| [community-mcp-trace.json](generated/community-mcp-trace.json) | Installed package: account read, invitation connection test, comment, cancellation; arguments and responses. Isolated fixture delivery. | `npm run verify:install` |
| [live-geoapify-trace.json](generated/live-geoapify-trace.json) | Actual Geoapify schemas and five MCP request/response pairs using public Prague locations. | `node --env-file-if-exists=.env scripts/smoke.js` |
| [live-transport-trace.json](generated/live-transport-trace.json) | Free-flow versus approximated routing and multi-stop pickup/return checks. | `npm run test:live-transport` |
| [trace.json](generated/trace.json) | Original repeatable deterministic planner: full request/response trace and expected failures. | `npm run demo` |

The other `generated/` files retain historical prototype evidence and derived
plans. They are not the current app's database. Provider credentials, session
cookies and authentication headers are excluded. Public-place coordinates and
sample accounts remain where needed to understand the calculation.

## What to inspect

1. Compare the requested preferences with the final people, time and place.
2. Follow failed candidate checks as well as the accepted choice.
3. Look for both outward and return travel, including setup and pack-up.
4. Confirm that access remains unverified unless explicitly checked.
5. Read the provenance field before treating a forecast or route as live data.

Integration scripts require the dependencies and login/key described in the
README. They write refreshed evidence under `examples/generated/`.
