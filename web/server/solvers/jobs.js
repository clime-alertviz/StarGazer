import { randomUUID, createHash } from "node:crypto";

export class PlanningJobs {
  constructor(hub) {
    this.hub = hub;
    this.jobs = new Map();
  }
  start(userId, input) {
    this.hub.user(userId);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const active = [...this.jobs.values()].find(
      (j) => j.userId === userId && j.status === "running",
    );
    if (active) {
      if (active.fingerprint === fingerprint)
        return this.view(userId, active.id);
      throw new Error(
        "Your current plan is still running. Finish or stop it before starting another.",
      );
    }
    if (
      [...this.jobs.values()].filter((j) => j.status === "running")
        .length >= 8
    )
      throw new Error("The planner is busy. Try again shortly.");
    const job = {
      id: randomUUID(),
      userId,
      fingerprint,
      controller: new AbortController(),
      status: "running",
      events: [],
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    for (const old of this.jobs.values())
      if (this.jobs.size > 50 && old.status !== "running")
        this.jobs.delete(old.id);
    job.task = this.hub
      .plan(userId, input, {
        signal: job.controller.signal,
        beforeCommit: () => {
          job.controller.signal.throwIfAborted();
          job.committing = true;
        },
        onProgress: (message) => {
          if (!job.controller.signal.aborted)
            job.events.push({
              at: new Date().toISOString(),
              message,
            });
          if (job.events.length > 30) job.events.shift();
        },
      })
      .then((result) => {
        if (!job.controller.signal.aborted)
          Object.assign(job, { status: "completed", result });
      })
      .catch((error) => {
        if (!job.controller.signal.aborted)
          Object.assign(job, {
            status: "failed",
            error:
              error.issues?.map((i) => i.message).join("; ") ||
              error.message,
          });
      });
    return this.view(userId, job.id);
  }
  view(userId, jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.userId !== userId)
      throw new Error("Planning job not found.");
    return {
      id: job.id,
      status: job.status,
      events: job.events,
      result: job.result,
      error: job.error,
    };
  }
  cancel(userId, jobId) {
    this.view(userId, jobId);
    const job = this.jobs.get(jobId);
    if (job.committing && job.status === "running")
      throw new Error(
        "Your draft is already being saved. Wait for the result.",
      );
    if (job.status === "running") {
      job.status = "cancelled";
      job.controller.abort();
    }
    return this.view(userId, jobId);
  }
  async close() {
    for (const job of this.jobs.values())
      if (job.status === "running") {
        job.status = "cancelled";
        job.controller.abort();
      }
    await Promise.allSettled([...this.jobs.values()].map((j) => j.task));
  }
}
