# A night with StarGazer

[Watch the short video](showcase.mp4) · [Open the tutorial page](index.html)
· [Back to setup](../README.md)

Find a good night, a reachable place and people to share it with.
Locations and journeys are powered by [Geoapify](https://www.geoapify.com/).

## Start here

Follow the four commands in the [README](../README.md#try-the-web-demo), then open
[the local demo](http://127.0.0.1:4318). Browse without signing in. To take part,
sign in as `mia@stargazer.test`: open **Local outbox**, follow your link and click
**Continue**. Use a different test address if you want a fresh profile.

## Join a night that catches your eye

1. Choose **Plan your next adventure**. Pick an avatar and share your interests.
2. Choose your public starting point and available evenings. Add more slots or
   tick **Repeat each week** if you like. Include the journey home.
3. Browse the suggested **Nights you could join** while filling in your answers.
   You can also go straight to any open outing from the home page.
4. Open one. Read who is going, what they bring, the sky report and expected weather.
5. Choose **Check my journey & join**. Make your own way, or choose an offered
   pickup. A lift must fit the available seats and complete journey.
6. Under **Invitation preference**, choose email or Google Calendar. Review the
   meeting/pickup and return times, then choose **Join this evening**.
7. Your answer, journey and group are now on the outing page. Add a comment to
   discuss arrangements. Use **Invite to my circle** to keep in touch; the other
   person decides whether to accept.

A suggested outing is a possibility, not a reserved place. The final join checks
current capacity and travel. For the simplest first test, choose **I’ll make my
own way** and confirm that you can meet at the displayed time.

## Organize your own

1. Finish the evening setup and choose **Organize my own evening**.
2. Choose what to observe, **Available from**, **Home by**, observing minutes and
   group size. After midnight, Home by uses the following date.
3. Decide whether remaining places are open to others or limited to your circle.
   Choose circle members to consider, then click **Create outing**.
4. The agent compares possible groups, places, conditions and journeys. Review
   **Why this plan**, the reports and your complete travel times on the draft.
5. Check night access, the meeting point and final walk. Record that confirmation
   under **Edit time, place or night access** when needed.
6. Under **Review & invite**, choose direct invitations and any remaining open
   places, set the response deadline, then invite.
7. Guests respond by their chosen channel or on the page. The outing confirms
   once the minimum group and required equipment/transport have accepted.

An open draft can start with just you. A driver is only needed for car-dependent
journeys; walking and cycling outings do not require one. An unresolved lift
stays visible until it is arranged.

## Before heading out

Refresh the weather, check responses and review the journey home. The organizer
can edit the time/place or cancel. Material changes request reconfirmation on
the page and update the existing Calendar event. **Settings → Profile &
preferences** lets you edit remembered defaults without changing past agreements.

For real emails and Calendar invitations, follow [provider setup](providers.md).
A local outing link opens on the computer running the app; Calendar responses
can still be made elsewhere and imported by that local app.

## Prefer to use Codex?

Install the plugin from the [README](../README.md#install-the-codex-plugin), then:

> Use StarGazer. Find a beginner-friendly evening I can join. Show the people,
> observing conditions and full journey before I decide.

You can organize, review, invite and coordinate from the same chat. See
[example requests](../examples/requests.md) and the [AI workflow](ai-workflow.md).

## What the sample community covers

The seed creates eight upcoming outings: open, circle-only, full, photography,
shared-car, no-spare-seat and poor-weather cases. Public discovery shows only
eligible open outings. Its sample forecasts and access records are fixtures;
astronomy is calculated. Live planning uses your configured providers.

To start over, stop the demo, run `npm run seed -- --reset`, then
`npm run web:demo`. This resets only the separate sample database.
