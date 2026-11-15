# Example requests

Use the StarGazer skill with the shared service running and your MCP token set.
The same account and outings appear in the GUI.

| Request | Main tool sequence | Expected result |
| --- | --- | --- |
| “I’m free Tuesday or Friday evening, every week. I’d like to learn and can drive or get a lift.” | `get_state` → `save_preferences` → `list_outing_candidates` | Weekly slots and flexible travel saved; potential open matches shown. |
| “Show me that Saturn evening and check whether I can join.” | `get_outing` → `preview_join` → reviewed `join_outing` | A place is taken only if capacity and complete journeys fit. |
| “Organize a night with my circle and leave extra places open.” | `begin_planning` → Geoapify + sky tools → `register_planning_site` → `check_plan_candidate` → `save_plan_candidate` → review → `invite_outing` | Circle proposal, reserved direct invitations and genuinely open remaining places. |
| “What’s the sky looking like? Show me the Moon and forecast.” | `get_outing` → `refresh_weather` if organizer | Target altitude, darkness, Moon, expected weather and retrieval time. |
| “Ask whether my driver can meet at the station.” | `get_outing` → `add_comment` with the relevant parent ID | A threaded reply; organizer and reply author notified. |
| “Invite Adam from our outing into my circle.” | `get_outing` → `invite_to_circle` | A pending circle invitation, separate from attendance. |
| “Check the Calendar responses.” | `check_calendar` | Observed responses imported without overwriting newer app answers. |
| “Move our observing time and notify everyone.” | `get_outing` → `edit_outing` | Active journeys and conditions rechecked; same event updated; page reconfirmation required. |
| “Cancel because the forecast has worsened.” | `refresh_weather` → `cancel_outing` after authorization | Outing closes and the linked Calendar event is cancelled. |
| “Recover the Calendar update that timed out.” | `recover_calendar` | Existing event and marker checked; no blind duplicate creation. |

For failure cases, try a full group, a passenger with no available offered seat,
a slot covering observing but not return travel, a private outing from an unrelated
account, and an old revision response. Each must fail without changing the group.

`examples/generated/` also retains traces from the original local planner. Those
files describe the recorded prototype runs, not the current shared account flow.

## Organize entirely from local Codex

> Use StarGazer to plan a quiet photography evening with someone happy to teach.
> Do the matching here in Codex. Save the draft for me to review.

Expected tools: `get_state`, `begin_planning`, Geoapify `search_places` and route
comparisons, `get_weather_forecast`, `calculate_astronomy`,
`register_planning_site`, repeated `check_plan_candidate`, then
`save_plan_candidate`. The chat chooses the group/site/time; backend LLM calls
are not part of this flow. The draft is visible in the web app too.

> Invite the selected people using my connected Gmail and Calendar integrations.

Expected tools: verify connector account, `set_outing_delivery` (`codex`),
`invite_outing`, then list/claim connector deliveries, send with the appropriate
integration and record each real provider ID. Use the same event ID for updates.
`import_calendar_responses` imports a fresh connector read. These sends require
the requested recipients and a reviewed, publishable plan.

> Compare two observing spots reachable from my public starting point. Show the
> walking times, then check weather and Saturn's altitude before proposing one.

Expected: Codex chooses the individual Geoapify, forecast and astronomy calls,
registers the selected candidates with StarGazer and validates its proposal.
The registered source is provenance, not proof of night access.
