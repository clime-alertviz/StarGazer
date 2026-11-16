import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  preferencesSchema,
  profileSchema,
  discoveryPreferencesSchema,
} from "./availability.js";
import { joinDetailsSchema } from "./join.js";
import { addressQuery } from "./addresses.js";
import { researchedSite } from "../../src/providers/planning.js";
import { site, target, instant, location } from "../../src/schema.js";
import { deliverCalendar, syncCalendar, pump } from "./delivery.js";

const outingId = z.string().max(100),
  empty = z.object({}).strict();
const planningRequest = z
  .object({
    target,
    start: instant,
    end: instant,
    durationMinutes: z.number().int().min(30).max(180).default(60),
    minPeople: z.number().int().min(1).max(8).default(2),
    maxPeople: z.number().int().min(1).max(8).default(4),
    visibility: z.enum(["circle", "open"]).default("open"),
    needsGuide: z.boolean().default(false),
    site: site.optional(),
    participantIds: z.array(z.string()).max(7).optional(),
  })
  .strict();
const sessionId = z.string();
export function operations(hub, id, client = "local") {
  const signin = {
    description:
      "Request an email sign-in link. Open it and click Continue in a browser, then create an MCP access token in Settings. No private data is returned. This sends a sign-in email.",
    schema: z
      .object({ email: z.email(), returnTo: z.string().optional() })
      .strict(),
    run: (data) => hub.identity.request(data.email, data.returnTo, client),
  };
  if (!id) return { request_signin: signin };
  return {
    request_signin: signin,
    list_outing_candidates: {
      description:
        "Fetch eligible outing data without running a backend LLM. YOU compare interests and rank these candidates locally. A suggestion is not a checked ride; use preview_join before joining.",
      schema: z
        .object({
          preferences: discoveryPreferencesSchema.optional(),
          anyDate: z.boolean().optional(),
        })
        .strict(),
      read: true,
      run: (data) => hub.discoverCandidates(id, data),
    },
    begin_planning: {
      description:
        "Start a client-led planning session and read the fixed request and eligible circle profiles. YOU do the reasoning in this Codex chat. No backend LLM runs. Session lasts 20 minutes; no draft or invitation is created.",
      schema: planningRequest,
      run: (data) => hub.clientPlanning.begin(id, data),
    },
    register_planning_site: {
      description:
        "Register a site YOU researched through Geoapify or another source in your planning session. Pass observing and meeting coordinates, final walk and evidence source. Night access remains unverified. No model runs.",
      schema: researchedSite.extend({ planningId: sessionId }).strict(),
      run: ({ planningId, ...data }) =>
        hub.clientPlanning.run(id, planningId, "register_site", data),
    },
    find_planning_sites: {
      description:
        "Fetch candidate sites through Geoapify for your planning session; no model or winner selection.",
      schema: z.object({ planningId: sessionId }).strict(),
      read: true,
      run: (data) =>
        hub.clientPlanning.run(id, data.planningId, "discover_sites", {}),
    },
    inspect_planning_conditions: {
      description:
        "Get calculated sky and forecast windows for a candidate site. YOU choose a time leaving room for journeys. Follow nextOffset for more results.",
      schema: z
        .object({
          planningId: sessionId,
          siteId: z.string(),
          offset: z.number().int().min(0).max(336).default(0),
        })
        .strict(),
      read: true,
      run: ({ planningId, ...data }) =>
        hub.clientPlanning.run(id, planningId, "inspect_conditions", data),
    },
    check_plan_candidate: {
      description:
        "Validate YOUR exact proposed group, time, site and offered travel modes. Returns a candidate ID when hard checks pass. needs_weather_review is a private draft with an advisory forecast warning; prefer suitable weather, but it can be saved for organizer review. Missing weather, astronomy and journey failures still block candidates. allowIncomplete supports open organizer-only drafts with explicit missing resources.",
      schema: z
        .object({
          planningId: sessionId,
          siteId: z.string(),
          start: instant,
          participantIds: z.array(z.string()).min(1).max(8),
          transports: z.record(
            z.string(),
            z.enum(["drive", "ride", "walk", "bicycle"]),
          ),
          allowIncomplete: z.boolean().default(false),
        })
        .strict(),
      read: true,
      run: ({ planningId, ...data }) =>
        hub.clientPlanning.run(id, planningId, "evaluate_candidate", data),
    },
    save_plan_candidate: {
      description:
        "Save the checked candidate YOU chose as an outing draft with your concise explanation. Idempotent for this session. No invitations are sent.",
      schema: z
        .object({
          planningId: sessionId,
          candidateId: z.string(),
          explanation: z.string().trim().min(1).max(1600),
        })
        .strict(),
      run: (data) => hub.clientPlanning.save(id, data),
    },
    discard_planning: {
      description: "Discard your unfinished client-led planning session.",
      schema: z.object({ planningId: sessionId }).strict(),
      run: (data) => hub.clientPlanning.discard(id, data.planningId),
    },
    set_outing_delivery: {
      description:
        "Choose who sends this outing's notifications: server providers or this user's connected Codex email/Calendar integrations. Select codex BEFORE inviting to avoid duplicate sends. In codex mode subsequent edits/joins queue work until Codex sends it.",
      schema: z
        .object({ outingId, mode: z.enum(["server", "codex"]) })
        .strict(),
      run: (data) =>
        hub.connectorDelivery.configure(id, data.outingId, data.mode),
    },
    list_connector_deliveries: {
      description:
        "List notifications that YOU must deliver through your connected mailbox/Calendar. No send happens here.",
      schema: empty,
      read: true,
      run: () => hub.connectorDelivery.list(id),
    },
    claim_connector_delivery: {
      description:
        "Claim a pending email or Calendar create/update/cancellation and get its exact payload. Server delivery is excluded. Verify the connected sender matches accountEmail. If recoveryRequired, inspect the provider before sending again.",
      schema: z
        .object({
          kind: z.enum(["email", "calendar"]),
          deliveryId: z.string(),
        })
        .strict(),
      run: (data) => hub.connectorDelivery.claim(id, data),
    },
    record_connector_delivery: {
      description:
        "Record real integration evidence after sending: Gmail message ID or Google event ID. Use uncertain on ambiguous failure. Use not_sent only after provider verification, with recoveryNote, to release for retry. Never invent a receipt. Updates keep the same event ID.",
      schema: z
        .object({
          kind: z.enum(["email", "calendar"]),
          deliveryId: z.string(),
          claimToken: z.string(),
          outcome: z.enum(["sent", "uncertain", "not_sent"]),
          providerId: z.string().min(1).optional(),
          url: z.string().optional(),
          recoveryNote: z.string().trim().min(1).max(1000).optional(),
        })
        .strict(),
      run: (data) => hub.connectorDelivery.complete(id, data),
    },
    import_calendar_responses: {
      description:
        "Import a fresh read of the linked event from YOUR Google Calendar integration. Supply the outing revision and read start timestamp. Page responses and reconfirmation rules remain authoritative.",
      schema: z
        .object({
          outingId,
          revision: z.number().int().min(1),
          readAt: instant,
          event: z
            .object({
              id: z.string(),
              status: z.string().optional(),
              attendees: z
                .array(
                  z
                    .object({
                      email: z.email(),
                      responseStatus: z.enum([
                        "accepted",
                        "declined",
                        "tentative",
                        "needsAction",
                      ]),
                    })
                    .passthrough(),
                )
                .optional(),
            })
            .passthrough(),
        })
        .strict(),
      run: (data) => hub.connectorDelivery.importResponses(id, data),
    },
    get_state: {
      description:
        "Read your own profile, circle, invitations, outings and provider connection status.",
      schema: empty,
      read: true,
      run: () => hub.state(id),
    },
    save_preferences: {
      description:
        "Save your name, interests and evening defaults. Multiple dated slots and weekly recurrence are supported. Seats and travel offers are reconfirmed for each outing.",
      schema: profileSchema,
      run: (data) => hub.saveProfile(id, data),
    },
    autocomplete_address: {
      description:
        "Suggest addresses from typed text, optionally biased by nearby coordinates. A selected result is a named public starting or pickup point.",
      schema: addressQuery,
      read: true,
      run: (data) => hub.autocomplete(id, data),
    },
    nearby_location: {
      description:
        "Identify the nearby town from browser coordinates the user allowed. Does not save precise device coordinates to the profile.",
      schema: location,
      read: true,
      run: (data) => hub.nearby(id, data),
    },
    get_join_options: {
      description:
        "Read offered public pickup points, remaining seats and meeting times before the short join flow. No profile completion required.",
      schema: z.object({ outingId }).strict(),
      read: true,
      run: (data) => hub.joinOptions(id, data.outingId),
    },
    find_outings: {
      description:
        "Rank visible open places using partial evening preferences. Set anyDate to browse beyond saved availability. These are potential matches; join_outing checks complete journeys and capacity atomically.",
      schema: z
        .object({
          preferences: discoveryPreferencesSchema.optional(),
          anyDate: z.boolean().optional(),
          retry: z.boolean().optional(),
        })
        .strict(),
      read: true,
      run: (data) => hub.discover(id, data),
    },
    get_outing: {
      description:
        "Read an outing, astronomy, weather, group responses and your journey. Private profile locations are not shared.",
      schema: z.object({ outingId }).strict(),
      read: true,
      run: (data) => hub.view(data.outingId, id),
    },
    get_traffic_report: {
      description:
        "Compare outward and return driving estimates with free-flow times using Geoapify MCP. Only for outings with an active driver. Estimates include pickup routes, exclude dwell and buffers, and are not live or departure-time traffic forecasts. Cached for 15 minutes.",
      schema: z.object({ outingId }).strict(),
      read: true,
      run: (data) => hub.trafficReport(id, data.outingId),
    },
    plan_outing: {
      description:
        "Find a weather- and astronomy-appropriate observing window, site and recommended group from your own circle. Start means Available from; end means Home by, including travel both ways, setup and pack-up. These dates override the organizer's saved availability for this outing only. Persists a draft. Open drafts may need a driver, telescope or guide; these remain unconfirmed until arrangements work. Does not send invitations. Unknown site access must be confirmed before inviting.",
      schema: z
        .object({
          target,
          solver: z.enum(["codex", "deterministic"]).optional(),
          start: instant,
          end: instant,
          durationMinutes: z.number().int().min(30).max(180).default(60),
          minPeople: z.number().int().min(1).max(8).default(2),
          maxPeople: z.number().int().min(1).max(8).default(4),
          visibility: z.enum(["circle", "open"]).default("open"),
          needsGuide: z.boolean().default(false),
          site: site.optional(),
          participantIds: z.array(z.string()).max(7).optional(),
        })
        .strict(),
      run: (data) => hub.plan(id, data),
    },
    start_plan: {
      description:
        "Start planning in the background, using Codex by default. Poll get_plan_job for tool progress and the resulting draft. Does not send invitations.",
      schema: z
        .object({
          target,
          start: instant,
          end: instant,
          durationMinutes: z.number().int().min(30).max(180).default(60),
          minPeople: z.number().int().min(1).max(8).default(2),
          maxPeople: z.number().int().min(1).max(8).default(4),
          visibility: z.enum(["circle", "open"]).default("open"),
          needsGuide: z.boolean().default(false),
          site: site.optional(),
          participantIds: z.array(z.string()).max(7).optional(),
          solver: z.enum(["codex", "deterministic"]).optional(),
        })
        .strict(),
      run: (data) => hub.planningJobs.start(id, data),
    },
    get_plan_job: {
      description:
        "Read your own planning progress or completed draft. A failed agent job never silently switches to another solver.",
      schema: z.object({ jobId: z.string() }).strict(),
      read: true,
      run: (data) => hub.planningJobs.view(id, data.jobId),
    },
    cancel_plan_job: {
      description:
        "Stop your running planning job. No draft or invitation is created after cancellation.",
      schema: z.object({ jobId: z.string() }).strict(),
      run: (data) => hub.planningJobs.cancel(id, data.jobId),
    },
    invite_outing: {
      description:
        "Publish the reviewed outing and send invitations to selected circle members. Set confirmAccess only after the organizer confirms night access, the meeting point and final walk; this saves the confirmation with the invitations. Reserves pending invitation places until expiry; open outings expose remaining places. When get_outing returns weatherReviewRequired, show weatherWarnings and pass weatherConfirmationKey as weatherConfirmation only after explicit organizer acknowledgement. This sends notifications.",
      schema: z
        .object({
          outingId,
          participantIds: z.array(z.string()).max(7),
          deadline: instant.optional(),
          holdHours: z.number().min(1).max(168).default(24),
          visibility: z.enum(["circle", "open"]).optional(),
          confirmAccess: z.boolean().optional(),
          weatherConfirmation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        })
        .strict(),
      run: (data) => hub.invite(id, data),
    },
    preview_join: {
      description:
        "Check your complete proposed journey before joining. Returns your transport, departure, home time, own pickup/driver and previewKey; does not reserve a place. Review before join_outing.",
      schema: z
        .object({
          outingId,
          preferences: preferencesSchema.optional(),
          details: joinDetailsSchema.optional(),
        })
        .strict(),
      read: true,
      run: (data) => hub.previewJoin(id, data),
    },
    join_outing: {
      description:
        "Join an open place after reviewing preview_join and authorizing participation. Pass expectedVersion and expectedPreview from its version and previewKey to reject changed journeys or answers. Checks full availability, car seats, pickups, walking and return travel. Sends the chosen-channel confirmation.",
      schema: z
        .object({
          outingId,
          preferences: preferencesSchema.optional(),
          details: joinDetailsSchema.optional(),
          expectedVersion: z.number().int().optional(),
          expectedPreview: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        })
        .strict(),
      run: (data) => hub.join(id, data),
    },
    respond_outing: {
      description:
        "Guests accept, decline or answer maybe for the exact displayed plan revision. Acceptance confirms the shown travel and equipment arrangements. Organizers are attending by default: they can confirm changed arrangements with accepted, or use cancel_outing if they cannot attend.",
      schema: z
        .object({
          outingId,
          response: z.enum(["accepted", "declined", "tentative"]),
          revision: z.number().int(),
        })
        .strict(),
      run: (data) => hub.respond(id, data),
    },
    add_comment: {
      description:
        "Add a participant comment or reply. Emails the organizer and the direct reply author, excluding the commenter.",
      schema: z
        .object({
          outingId,
          text: z.string().min(1).max(2000),
          replyTo: z.string().optional(),
        })
        .strict(),
      run: (data) => hub.comment(id, data),
    },
    refresh_weather: {
      description:
        "Organizer refreshes the forecast and its retrieval time. Poor conditions flag the plan for review.",
      schema: z.object({ outingId }).strict(),
      run: (data) => hub.weather(id, data),
    },
    edit_outing: {
      description:
        "Organizer revises the observing window or site. Optional availability replaces only their available hours for this outing. Rechecks active participants, journeys, sky and weather; decliners do not block edits. A weather_review result saves nothing: show its warnings and, only after the organizer explicitly chooses Save anyway, repeat the same request with its confirmationKey as weatherConfirmation. Changed conditions require fresh review. Successful edits update the same Calendar event; the organizer stays accepted and guests reconfirm.",
      schema: z
        .object({
          outingId,
          start: instant,
          end: instant,
          site,
          deadline: instant.optional(),
          weatherConfirmation: z.string().regex(/^[a-f0-9]{64}$/).optional(),
          availability: z
            .object({ start: instant, end: instant })
            .strict()
            .optional(),
        })
        .strict(),
      run: (data) => hub.edit(id, data),
    },
    cancel_outing: {
      description:
        "Cancel an outing and notify its active guests by their chosen channel. Cancels the existing Calendar event.",
      schema: z
        .object({ outingId, reason: z.string().min(1).max(1000) })
        .strict(),
      run: (data) => hub.cancel(id, data),
    },
    invite_to_circle: {
      description:
        "Invite a friend by email, or someone you share an outing with by userId. Acceptance creates a mutual connection; it is separate from outing attendance.",
      schema: z
        .object({
          email: z.email().optional(),
          userId: z.string().optional(),
        })
        .strict()
        .refine(
          (v) => Boolean(v.email) !== Boolean(v.userId),
          "Supply either email or userId",
        ),
      run: (data) => hub.circleInvite(id, data),
    },
    respond_circle: {
      description:
        "Accept or decline a circle invitation addressed to you.",
      schema: z
        .object({ invitationId: z.string(), accept: z.boolean() })
        .strict(),
      run: (data) => hub.circleRespond(id, data),
    },
    check_calendar: {
      description:
        "Organizer reads real Calendar responses. An old Calendar acceptance never reconfirms a revised plan or overwrites a newer app response.",
      schema: z.object({ outingId }).strict(),
      run: async (data) => {
        hub.owner(hub.outing(data.outingId), id);
        if (hub.outing(data.outingId).deliveryMode === "codex")
          throw new Error(
            "Read the linked event through your Calendar integration, then call import_calendar_responses.",
          );
        await syncCalendar(hub, data.outingId);
        return hub.view(data.outingId, id);
      },
    },
    recover_calendar: {
      description:
        "Reconcile the existing Calendar event with the latest saved plan. Uses the same event ID, reads uncertain writes first, and can recover a cancellation.",
      schema: z.object({ outingId }).strict(),
      run: async (data) => {
        const o = hub.outing(data.outingId);
        hub.owner(o, id);
        if (o.deliveryMode === "codex")
          throw new Error(
            "Reconcile this event through your Calendar integration and record_connector_delivery.",
          );
        if (!o.calendar)
          throw new Error("There is no Calendar invitation to reconcile.");
        o.migrationPaused = false;
        hub.queueCalendar(o);
        await deliverCalendar(hub, o.id, { retry: true });
        return hub.view(o.id, id);
      },
    },
    connect_google: {
      description:
        "Return the OAuth setup link for your own Gmail/Calendar account. Complete it in a browser. The hosted server needs this authorization separately from Codex.",
      schema: empty,
      run: () => hub.providers.connect(id),
    },
    send_connection_test: {
      description:
        "Send a clearly labelled Calendar or email connection test to a second account the user controls. No physical outing is planned. This sends an invitation.",
      schema: z
        .object({
          guestEmail: z.email(),
          start: instant,
          timezone: z.string(),
          channel: z.enum(["email", "calendar"]).default("calendar"),
        })
        .strict(),
      run: (data) => hub.createTest(id, data),
    },
    list_messages: {
      description:
        "Read delivery status and messages sent to your own account. Local-only messages are available for end-to-end testing.",
      schema: empty,
      read: true,
      run: () =>
        hub.data.messages
          .filter(
            (m) => m.recipientId === id || m.to === hub.user(id).email,
          )
          .map(({ key, ...m }) => m),
    },
  };
}

export async function serveMcp(hub, id, req, res, body, client) {
  const server = new McpServer({
    name: "StarGazer",
    version: "0.4.0",
  });
  for (const [name, op] of Object.entries(operations(hub, id, client)))
    server.registerTool(
      name,
      {
        description: op.description,
        inputSchema: op.schema,
        annotations: {
          readOnlyHint: Boolean(op.read),
          destructiveHint: !op.read,
          openWorldHint: true,
        },
      },
      async (args) => {
        try {
          const value = await op.run(args);
          hub.audit(id, name, { ok: true });
          await hub.store.persist();
          // Provider work runs after the committed state change, outside the action lock.
          setImmediate(() => pump(hub).catch(() => {}));
          return {
            content: [{ type: "text", text: JSON.stringify(value) }],
          };
        } catch (error) {
          hub.audit(id, name, { ok: false });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: error.issues
                  ? error.issues.map((i) => i.message).join("; ")
                  : error.message,
              },
            ],
          };
        }
      },
    );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await transport.handleRequest(req, res, body);
}
