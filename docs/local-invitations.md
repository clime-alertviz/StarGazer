# Local invitations and responses

Use the current [provider setup and local test guide](providers.md).

The new shared service supports email or Calendar per participant. Calendar
invitations arrive when first invited; page responses work for either channel.
A scanner can open a sign-in link without consuming it. The user explicitly
clicks Continue to sign in.

The app stores its own outing lifecycle, response revision and reservation expiry.
An old Calendar response cannot reconfirm a changed plan. Organizer edits update
the linked event; cancellation cancels it. No public hosting is needed to test
Calendar responses or the local outbox.
