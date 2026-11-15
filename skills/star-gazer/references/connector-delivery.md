# Delivery through the user's Codex integrations

Use this when the organizer wants this Codex chat to send invitations through its
connected mailbox and Calendar. The service remains the shared record. It does
not inherit Codex credentials and does not send these outing notifications itself.
Only actions already requested by the user are authorized; setting a delivery
mode alone is not an instruction to send invitations.

## Send and record

1. Read the Gmail/Calendar integration account profile. It must match StarGazer's
   `accountEmail`; never silently send from a different account. Use the primary
   calendar. If the tools are unavailable, explain that connection is needed.
2. Set `set_outing_delivery({outingId, mode: "codex"})` BEFORE `invite_outing`.
   This also covers subsequent updates/cancellations. Existing uncertain sends
   must be reconciled before switching sender.
3. After the authorized invitation/edit/cancellation, `list_connector_deliveries`
   lists pending work. `claim_connector_delivery` returns the exact recipient,
   content and a persisted claim token. Claim before sending. Process one item
   at a time and record its result before claiming another.
4. Send via the relevant integration as described below. Preserve the outing
   link and visible delivery/sync markers. These enable recovery after a timeout.
5. `record_connector_delivery` with `outcome: "sent"`, `claimToken`, `kind`,
   `deliveryId` and the real returned `providerId` stores the receipt. Calendar
   success confirms an event write, not that a guest received an email.

For Gmail, map `to`, `subject`, and `text` to the send tool. If it prefers HTML,
escape the text and retain its line breaks. Record the Gmail message ID.

For Calendar `create`, map `summary` to title, `start.dateTime`/`end.dateTime` to
timed boundaries, `start.timeZone` to timezone, `attendees[].email` to the guest
list, plus description, location, private visibility and disabled guest edits.
Explicitly set **notify: true**. Only Calendar-channel guests belong on this
event. The supplied extendedProperties are optional when the connector lacks
that field; the description includes the recovery markers. Record the returned
Google event ID and optional HTTPS Calendar link.

For Calendar `update`, first read `eventId`. Update that SAME event, preserving
existing RSVP states; add/remove only the difference in guest addresses. Pass
**notify: true** with title/time/location/description changes. Do not recreate an
unreadable, missing or cancelled linked event automatically.

For `cancel`, delete the linked event. If it is already cancelled or the provider
confirms it was deleted, record success for the same ID. If `eventId` is null,
the event was never created: record this cancellation without an external write.
The current Calendar connector does not expose notification controls on delete;
do not promise cancellation-email delivery beyond what the provider confirms.

## Interrupted sends

`recoveryRequired: true` means an earlier claim may have sent successfully.
Do NOT send again immediately. Search sent mail for the delivery token, or read
/search Calendar using the outing ID and delivery/sync marker in the description.
If the write exists, record its actual ID. On an ambiguous error, record
`outcome: "uncertain"`; the claim remains blocked from automatic resend. If the
provider definitively confirms no send/write happened, use `outcome: "not_sent"`
and a concise `recoveryNote`, then obtain a fresh claim. An empty eventual-search
result alone is not proof. If uncertain, leave pending and explain what needs
checking. Never fabricate a receipt to clear an error.

## Calendar responses and later changes

Read `get_outing` for its revision, note the current ISO time BEFORE reading the
linked event, then `import_calendar_responses({outingId, revision, readAt, event})`.
Pass actual event ID and attendee email/responseStatus values. Data older than
five minutes is rejected. Material edits still require reconfirmation on the page;
Google does not provide per-attendee response timestamps.

Check pending deliveries after invitations, edits, cancellations and response
imports. Server delivery is excluded while `mode: codex` is selected. Updates
caused later by other participants wait until Codex handles them; for unattended
delivery choose server mode with authorized server providers. Sign-in links and
circle invitations remain service email, visible in the local outbox without a
provider. This mode is for outing-related organizer notifications.
