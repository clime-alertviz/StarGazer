# Connect email and Google Calendar

You can test profiles, circles, outings, responses and comments locally before
connecting any provider. The local outbox shows each message and its delivery
state. It is disabled when a hosted base URL is configured.

## Email

Set these in the ignored `.env` file and restart `npm run web`:

```dotenv
SMTP_URL=smtps://username:password@smtp.example.com:465
MAIL_FROM=StarGazer <you@example.com>
```

URL-encode special characters in SMTP credentials. Use your provider’s documented
TLS settings. [Nodemailer SMTP configuration](https://nodemailer.com/smtp).

System sign-in links use SMTP; hosted startup requires both settings above.
Once an organizer connects Gmail, outing invitations can use that account.
Comment notifications contain a link to the discussion and use the comment
author's connected account or the system sender, never another person's Gmail.
SMTP is the fallback after a failed token refresh or a definite Gmail rejection.
An uncertain send timeout does not trigger another send. Addresses ending
in `.test` always stay in the local outbox. Tokens, client secrets and SMTP
credentials are never included in the plugin package.

## Sign-in limits and reverse proxies

Sign-in requests allow three emails per recipient per minute (including `+tag`
aliases), and ten per client IP per minute or 100 per client IP per hour. There
is no shared application-wide quota for a single client to exhaust. A blocked
request returns HTTP 429 with `Retry-After` and explains that no new email was
queued. The same rules apply to existing and new accounts. Limits are held in
memory by the running server.

For direct local access, leave `STAR_GAZER_TRUSTED_PROXIES` unset. When hosting
behind a reverse proxy, set it to the proxy's actual IP address or CIDR range.
For example, for a proxy on the same computer:

```dotenv
STAR_GAZER_TRUSTED_PROXIES=127.0.0.1,::1
```

The proxy must set or append `X-Forwarded-For` using the connecting client's IP.
StarGazer checks the chain from the socket backwards through explicitly trusted
proxies and uses the first untrusted address as the client. Thus users behind the
proxy receive separate allowances. Forwarded headers from other peers are ignored.
Use only proxy addresses/ranges you control; do not trust the entire Internet.
A trusted proxy that omits or supplies an invalid client address gets a setup
error instead of silently putting everyone in one rate-limit bucket.

## Google OAuth

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Calendar API** and **Gmail API**.
3. In **Google Auth Platform**, configure **Branding** and choose an **External**
   audience in **Testing**. Add each organizer account under **Audience → Test
   users**. In **Data Access**, select `openid`, `userinfo.email`,
   `https://www.googleapis.com/auth/calendar.events` and
   `https://www.googleapis.com/auth/gmail.send`. Gmail/Calendar scopes may require
   Google verification before a wider public launch.
4. Create an OAuth client of type **Web application**. Add this exact authorized
   redirect URI for the default local instance:

   `http://127.0.0.1:4317/auth/google/callback`

   If using the separate sample instance on port 4318, also add
   `http://127.0.0.1:4318/auth/google/callback`. JavaScript origins are not needed
   for this server-side flow. Download the client JSON when Google displays it;
   the secret may only be shown once. Keep it outside version control.

5. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.env`, then restart.
6. Sign in to StarGazer using the organizer’s Google email address. In
   **Settings**, click **Connect Google** and authorize that account.

The server requests email identity, Calendar event access and Gmail send access.
It uses authorization code + PKCE, validates state and the returned email identity,
and encrypts stored tokens. Google access belongs to this server; the service does
not inherit Codex’s Google integration. No service account or Workspace delegation
is required. [Google’s web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server).

In External Testing mode, these permissions produce a refresh token that expires
after seven days. Reconnect through **Settings → Connect Google** when it expires.
This is a Google testing restriction, not a requirement to host the app.
[Google’s refresh-token rules](https://developers.google.com/identity/protocols/oauth2#expiration).

Use a persistent `STAR_GAZER_ENCRYPTION_KEY` and public HTTPS
`STAR_GAZER_BASE_URL` when hosted. Register the corresponding HTTPS callback.
Changing the encryption key without reauthorizing makes existing grants unreadable.

## Real local accept/decline test

1. Connect the organizer account as above.
2. Open **Settings → Try a real response**.
3. Enter a second email account you control, choose a future test time and
   **Google Calendar**, then click **Send test invitation**.
4. In that account’s Calendar/email, choose Yes or No. The invitation includes
   a link to the local outing page.
5. On the organizer’s outing page, click **Check Calendar responses**. The server
   also checks every minute while running.
6. Open the outing link on the same computer, sign in as the guest through the
   local outbox or real email, and try responding on the page.
7. Cancel the test from the organizer page. It cancels the existing Calendar event.

A localhost link opens only on the machine running the service. You can still
accept the Calendar invitation from another device and import its response locally.
Google controls when an invitation appears in the guest’s calendar.

For email-only testing, select **Email** in the same test form. It works with the
local outbox and needs no Google account. The test makes no physical outing,
weather or route claim.

## Recovery

Calendar writes use a stable event ID and a saved synchronization marker. A lost
response is checked against the existing event before another write. Use
**Reconcile Calendar event** after fixing a provider connection. New edits and
cancellation remain queued even after an uncertain earlier update.
Temporary errors receive up to five attempts with increasing delays. Missing
authorization and permanent errors stop automatic retries. A previously delivered
event that disappears is not recreated automatically; review it in Google Calendar.
Calendar invitations require the organizer to connect Google first.

Imported outings are paused: loading an old database cannot expire its guests,
send migration notices or cancel Calendar events. The organizer can review and
edit the outing, cancel it deliberately, or reconcile its preserved Calendar event.

Email timeouts have uncertain delivery and are not automatically resent, because
that could duplicate a delivered message. Check the sender’s mailbox before
sending a replacement. Delivery state is visible in the outbox.

An old Calendar Yes cannot prove reconfirmation after a material edit. StarGazer
requires a fresh page response for that revision. App responses remain authoritative
when Calendar ordering is ambiguous.

## Use Codex's connected integrations instead

For an outing organized from local Codex, the StarGazer skill can send through
that client's Gmail/Google Calendar integrations. Configure `mode: codex` using
`set_outing_delivery` before inviting; claim each payload, call the connector,
and record the real message/event ID. Server OAuth is unnecessary for these
writes, and the server does not resend them. Follow the
[delivery procedure](../skills/star-gazer/references/connector-delivery.md),
including account matching and recovery from uncertain sends. Future changes
wait for Codex, unless the organizer switches to configured server delivery.
Sign-in/circle messages remain server email or local outbox.
