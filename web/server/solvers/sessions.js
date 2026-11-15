import { randomUUID } from "node:crypto";
import { createPlanningSession } from "./codex.js";

// The calling Codex client supplies the reasoning. These sessions contain only
// authorized data, provider queries and deterministic validation; no model runs.
export class ClientPlanning {
  constructor(hub) {
    this.hub = hub;
    this.sessions = new Map();
  }
  async begin(userId, input) {
    for (const [id, s] of this.sessions)
      if (s.expires < Date.now()) this.sessions.delete(id);
    if (
      this.sessions.size >= 100 ||
      [...this.sessions.values()].filter((s) => s.userId === userId)
        .length >= 5
    )
      throw new Error(
        "Finish or discard an existing planning session first.",
      );
    const context = this.hub.preparePlanning(userId, input);
    const session = createPlanningSession(context),
      planningId = randomUUID();
    this.sessions.set(planningId, {
      userId,
      context,
      session,
      expires: Date.now() + 20 * 60000,
    });
    return {
      planningId,
      expiresInMinutes: 20,
      ...(await session.callTool("read_planning_context", {})),
    };
  }
  get(userId, planningId) {
    const s = this.sessions.get(planningId);
    if (!s || s.userId !== userId || s.expires < Date.now())
      throw new Error(
        "Planning session not found or expired. Start a new session.",
      );
    return s;
  }
  run(userId, planningId, tool, args) {
    return this.hub.lock(`planning:${planningId}`, async () => {
      const s = this.get(userId, planningId);
      if (s.saved) throw new Error("This plan has already been saved.");
      return s.session.callTool(tool, args);
    });
  }
  save(userId, { planningId, candidateId, explanation }) {
    return this.hub.lock(`planning:${planningId}`, async () => {
      const s = this.get(userId, planningId);
      if (s.saved) return this.hub.view(s.saved, userId);
      this.hub.assertPlanningCurrent(s.context);
      if (!s.result) {
        await s.session.callTool("finish_plan", {
          candidateId,
          explanation,
        });
        s.result = s.session.result();
      }
      if (Date.parse(s.result.observingStart) <= Date.now())
        throw new Error(
          "This observing time has passed. Start a fresh plan.",
        );
      const outing = await this.hub.commitPlan(userId, s.context, s.result);
      s.saved = outing.id;
      return outing;
    });
  }
  discard(userId, planningId) {
    return this.hub.lock(`planning:${planningId}`, () => {
      this.get(userId, planningId);
      this.sessions.delete(planningId);
      return { discarded: true };
    });
  }
}
