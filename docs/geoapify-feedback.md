# Geoapify: tools used, lessons and feedback

Project: **StarGazer 0.4.0** · Author: Michal Novotný · Reviewed 16 November 2026.
Built with [Geoapify](https://www.geoapify.com/).

## Scope and evidence

This project primarily exercised **Geoapify MCP**, plus the address-autocomplete
REST endpoint. It did **not** generate a client from an OpenAPI document or run
an OpenAPI conformance audit. The OpenAPI suggestions below are requests for
clarity and parity, not claims of proven specification defects.

Evidence: [live request/response trace](../examples/generated/live-geoapify-trace.json),
[independent provider check](../examples/generated/providers-live-check.json),
[traffic/carpool check](../examples/generated/live-transport-trace.json).
The first trace includes the actual `tools/list` schemas used by the adapter.

## APIs and tools used

| Tool/API | Use in StarGazer | What worked |
| --- | --- | --- |
| MCP `geocode_address` | Resolve public starting places | Coordinates, formatted labels and confidence/granularity metadata |
| MCP `list_place_categories` | Discover valid categories | Avoided inventing category names; supplied viewpoints, parks and facilities |
| MCP `search_places` | Find candidate observing places, parking and public meeting points | Radius queries and compact place results with source/access metadata |
| MCP `calculate_route_matrix` | Compare participants against sites and pickups | Batch journey comparisons with explicit seconds/meters |
| MCP `calculate_route` | Validate selected outward/return trips and multi-stop carpools | Per-leg durations support pickup/drop-off scheduling; geometry can be omitted |
| REST `/v1/geocode/autocomplete` | Suggestions while typing in the web form | Backend location bias and explicit selection; key stays off the browser |

Both the local Codex chat and the website's background agent receive the five
Geoapify tools directly. Their adapter forwards individual calls to Geoapify MCP.
The shared validator independently checks the final routes before saving.

## Corrections and practical lessons

These are corrections to our integration or product assumptions:

- **Units:** MCP route and matrix responses expose `time_units: seconds` and
  `distance_units: meters`. We validate those fields, then round travel minutes
  upward. In the recorded public Prague walk, 378 matrix seconds and 377.836
  detailed-route seconds both became seven minutes.
- **Traffic:** Both routing schemas default to `free_flow`. We now explicitly
  request `approximated` for driving and compare it with free-flow on the outing
  page. It is not live traffic or a prediction for a specific departure time.
- **Round trips and legs:** A one-way matrix is insufficient. We check outward
  and return directions, final walks, pickup stops, setup and pack-up. Missing
  or unreachable route cells do not become zero-minute journeys.
- **Search radius:** A nearby park may be appropriate when a viewpoint is too
  far away. We added origin- and travel-limit-based search hints and multiple
  place categories. A place's straight-line distance never replaces a route check.
- **Access:** The recorded parking result included `access: private`. Finding a
  mapped place does not establish night access, permission or sky quality.
  Researched places remain unverified until the organizer checks them.
- **Autocomplete:** A short query such as “Zla” can be ambiguous. We added a
  250 ms debounce, nearby bias, town context, explicit result selection and
  cancellation of stale responses. Suggestions remain backend requests.
- **LLM context:** One failure used old profile availability while the form
  displayed a new evening. That was our application bug, not a Geoapify issue.
  Both model input and route validation now use the same confirmed snapshot.

## MCP feedback

1. **Keep the compact outputs and explicit units.** They fit agent workflows well
   and avoid spending context on unnecessary geometry. `geometry_scope: none` is
   particularly useful for constraint checks.
2. **Explain traffic semantics in the tool description itself.** The captured
   schema says “Traffic model used for motorized routing.” An explicit statement
   about live versus approximate traffic, and whether departure time is supported,
   would prevent agents and users from over-interpreting the result.
3. **Add a complete round-trip/carpool example.** Show source/target indexing,
   unreachable cells, route-leg ordering and separate return routing. These details
   matter when an agent turns durations into pickup commitments.
4. **Make the category list easy to narrow.** A prefix/search option, with a few
   common examples, would reduce the large category response in an agent's context.
5. **Expose actionable error structure.** Stable codes distinguishing invalid
   input, missing coverage, quota exhaustion and retryable service failures would
   let clients explain the next step without guessing from text.
6. **Show the interactive-address path clearly.** Document when to use geocoding
   versus autocomplete, bias versus hard filters, and how confidence/granularity
   should affect result selection. A dedicated autocomplete MCP tool would be useful
   for agents; the web UI can continue using the REST endpoint.

## OpenAPI feedback

Our direct REST use was autocomplete; we did not independently validate the
OpenAPI specifications. Useful documentation/spec improvements to consider:

- Cross-link each MCP tool to the equivalent REST operation and identify any
  differences in field names, supported modes, defaults or output shape.
- Include examples with explicit distance/time units, nullable or unreachable
  matrix entries, multi-stop legs and both traffic models.
- Describe authentication and quota/error responses consistently across REST
  and MCP, including retry information where available.
- Make autocomplete examples demonstrate partial addresses, location bias and
  selecting a more precise result rather than automatically accepting the first.

These suggestions come from this integration's needs. The recorded live checks
passed; this note does not claim that Geoapify is responsible for StarGazer's
profile, UI, forecasting or astronomy logic.
