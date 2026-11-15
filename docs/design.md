# Workflow and implementation

## Identity and preferences

An email sign-in link creates an account when explicitly confirmed. GET requests
do not consume it. One account can use a browser session and a revocable MCP token.
The GUI and Codex invoke the same authenticated operations.

Reusable preferences are learned from previous evening answers. Each participation
stores its own snapshot of availability, travel and equipment offers. Editing the
profile does not silently alter an already accepted outing. Weekly slots use local
wall-clock time in an IANA timezone and retain that time across DST transitions.

## Discovery, circles and places

Open outings rank against the answers collected so far. An early suggestion is
provisional; a join validates the complete round trip. Circle-only outings are
visible to that organizer’s circle and directly named participants. A circle
invitation needs recipient acceptance and creates a mutual relationship.

Organizer proposals consider their circle. A search uses at most seven companions
plus the organizer; larger circles can be narrowed before planning. Interests rank
choices rather than blocking someone who explicitly wants to attend.

The organizer counts toward capacity. Accepted members and unexpired pending or Maybe responses occupy places. Declined, withdrawn and expired invitations release them.
A direct invitation’s hold duration is independent of the final formation deadline.
Full groups reject further joins. A free group place does not imply a free car seat.
Network route validation happens outside the mutation lock; the commit checks the
outing version and capacity again, so two users cannot take the final place.

## Lifecycle

| State | Meaning / transition |
| --- | --- |
| Draft | Computed proposal; nobody has been notified. |
| Invited | Published and gathering responses. |
| Confirmed | Organizer, minimum group, required equipment/guide and rides accepted. |
| Needs review | A previously workable plan changed or lost a necessary role/condition. |
| Didn’t come together | Formation deadline passed without a workable group. |
| Cancelled | Organizer cancelled; active guests notified and Calendar event cancelled. |
| Completed | Previously confirmed outing has ended, including one needing review. |

An unformed outing closes at its deadline. Every non-draft outing closes by its
end. Closed outings do not accept new responses or continue background Calendar
polling. Being full is separate from being confirmed.

## Planning and reports

The website uses background Codex for new proposals and semantic ranking.
Local Codex can fetch the authorized inputs, query independent Geoapify and
weather/astronomy MCP tools, and use granular planning tools to save its choice
without a backend model. The website agent receives the same direct provider
tools. Researched sites remain unverified until the organizer checks access. It chooses concrete people, a site, an observing start and offered travel
modes, asks shared code to validate each candidate, then selects a validated
candidate. Free-text interests influence these choices. Hard constraints are
never waived by model output. The original deterministic search remains a
separate selectable backend. [Solver details](solvers.md).

Discovery applies existing permission, availability, capacity and conditions
filters before the LLM orders the candidates. Until the agent returns, cards
retain their basic order and visibly say matching is pending. Failures are
explicit. Joining still performs the complete current journey/capacity check.

Geoapify MCP supplies places, route matrices and detailed outward/return routes.
The dedicated autocomplete REST endpoint is called only by the server, after a
250 ms UI debounce; stale suggestion responses are ignored. The key stays private.

A public origin can be a rider’s fallback pickup. Drivers may suggest up to three
public pickups. Routes enforce seats after equipment, extra driving each way,
walking limits, setup, pack-up, observing and getting home. Approximate traffic
and a buffer are not live congestion or departure-time prediction.

Open-Meteo forecasts and Astronomy Engine calculations select suitable windows.
The outing page exposes cloud, wind, temperature, rain probability, forecast age,
Sun/target altitude and Moon illumination/altitude. The organizer can refresh the
weather and cancel. There is no continuous weather monitoring.

## Changes and delivery

Date, observing time, site/meeting point and changed ride arrangements require
review. Material organizer edits recheck active people, excluding decliners, and
ask for new page responses. A four-hour observing window is valid for an edit;
search duration remains an explicit 30–180-minute setting.

Email and Calendar are alternate outing-notification channels. Comments and
sign-in use email. Personal ride-response alerts also use email when there is no Calendar event update, so an affected driver or passenger hears about a changed answer. Replies notify the organizer and the parent comment’s author.
Comments render under their actual parent. RSVP changes notify the organizer;
minor status oscillations do not repeatedly notify the whole group.

Provider I/O never holds a participant-response lock. Calendar creation uses a
stable client-selected event ID. Updates carry a saved synchronization fingerprint.
After a timeout or restart, recovery reads that event before writing. Cancellation
uses the Calendar DELETE endpoint. A newer desired change remains queued after an
older write finishes. SMTP/Gmail uncertain deliveries are not blindly resent.

Calendar attendee responses have no individual timestamps. Locally observed
changes never overwrite an authoritative app answer or reconfirm a newer plan.
This conservative rule is displayed to the user when responses conflict.

## Storage and execution

One Node process owns one SQLite database. Secrets and runtime data stay under
ignored files; OAuth grants are encrypted. The original tables remain for
migration/history. The `community` setting stores the shared service state with
transactional snapshots, including users, circles, outings and delivery records.
This deliberately simple storage model is appropriate to the local first version;
a multi-process deployment would need normalized transactional records.

The new HTTP entry point is `web/hub.js`. The old local prototype is retained for
regression coverage and uses a different command; never run both against one DB.
