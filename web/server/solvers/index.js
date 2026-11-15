import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { CodexBridge } from "../codex.js";
import { solveDeterministically } from "./deterministic.js";
import { solveWithCodex, rankWithCodex } from "./codex.js";

export class CodexRuntime {
  constructor({ directory, bridge } = {}) {
    this.bridge =
      bridge ||
      new CodexBridge({
        cwd: resolve(directory || "private/web", "solver-agent"),
      });
    this.active = 0;
    this.queue = [];
    this.closed = new AbortController();
  }
  get model() {
    return this.bridge.lastModel || process.env.STAR_GAZER_MODEL;
  }
  async acquire(signal) {
    signal.throwIfAborted();
    if (this.active < 2) {
      this.active++;
      return;
    }
    if (this.queue.length >= 8)
      throw new Error(
        "The planning agent is busy. Please try again shortly.",
      );
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.abort = () => {
        this.queue = this.queue.filter((e) => e !== entry);
        reject(new Error("Planning was stopped."));
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next.signal.removeEventListener("abort", next.abort);
      next.resolve();
    } else this.active--;
  }
  async run(options) {
    const signal = AbortSignal.any([
      this.closed.signal,
      ...(options.signal ? [options.signal] : []),
    ]);
    await this.acquire(signal);
    try {
      options.onProgress?.("Connecting to your Codex planning agent.");
      if (this.bridge.status?.state !== "ready") {
        this.connecting ||= this.bridge.connect().finally(() => {
          this.connecting = null;
        });
        await this.connecting;
      }
      signal.throwIfAborted();
      if (this.bridge.status?.state !== "ready")
        throw new Error(
          "Codex is not ready. Run codex login on the server, then retry, or explicitly choose the rule-based planner.",
        );
      return await this.bridge.run({ ...options, signal });
    } finally {
      this.release();
    }
  }
  close() {
    this.closed.abort();
    this.bridge.close();
  }
}

export class SolverBackends {
  constructor({
    directory,
    defaultBackend = process.env.STAR_GAZER_SOLVER || "codex",
    runtime,
    rankingDelay = 1000,
  } = {}) {
    if (!["codex", "deterministic"].includes(defaultBackend))
      throw new Error("STAR_GAZER_SOLVER must be codex or deterministic.");
    this.defaultBackend = defaultBackend;
    this.runtime = runtime || new CodexRuntime({ directory });
    this.rankings = new Map();
    this.latest = new Map();
    this.rankingDelay = rankingDelay;
  }
  status() {
    return {
      defaultBackend: this.defaultBackend,
      codex: this.runtime.bridge?.status?.state || "available_on_request",
    };
  }
  async plan(backend, context) {
    if (backend === "codex") return solveWithCodex(context, this.runtime);
    if (backend !== "deterministic")
      throw new Error("Unknown solver backend.");
    context.onProgress?.(
      "Checking groups, viewing times and journeys with the rule-based planner.",
    );
    const result = await solveDeterministically(context);
    return {
      ...result,
      solver: {
        backend: "deterministic",
        summary:
          "Selected by the rule-based planner using availability, conditions and journey scores.",
      },
    };
  }
  rank(
    userId,
    preferences,
    candidates,
    { anyDate = false, retry = false, providers } = {},
  ) {
    if (!candidates.length || this.defaultBackend === "deterministic")
      return candidates;
    const key = createHash("sha256")
      .update(JSON.stringify({ userId, preferences, anyDate, candidates }))
      .digest("hex");
    const now = Date.now();
    let entry = this.rankings.get(key);
    if (
      entry &&
      ((retry && entry.status === "error") || entry.expires <= now)
    ) {
      entry.controller.abort();
      clearTimeout(entry.timer);
      this.rankings.delete(key);
      entry = null;
    }
    const previous = this.latest.get(userId);
    if (previous && previous !== key) {
      const old = this.rankings.get(previous);
      if (old?.status === "pending") {
        clearTimeout(old.timer);
        old.controller.abort();
        this.rankings.delete(previous);
      }
    }
    this.latest.set(userId, key);
    if (!entry) {
      entry = {
        status: "pending",
        expires: now + 10 * 60000,
        controller: new AbortController(),
      };
      this.rankings.set(key, entry);
      entry.timer = setTimeout(() => {
        rankWithCodex(
          this.runtime,
          preferences,
          candidates,
          entry.controller.signal,
          providers,
        )
          .then((choices) => {
            if (!entry.controller.signal.aborted)
              Object.assign(entry, { status: "ready", choices });
          })
          .catch((error) => {
            if (!entry.controller.signal.aborted)
              Object.assign(entry, {
                status: "error",
                error: error.message,
                expires: Date.now() + 60000,
              });
          });
      }, this.rankingDelay);
      entry.timer.unref?.();
      while (this.rankings.size > 100) {
        const oldest = this.rankings.keys().next().value,
          removed = this.rankings.get(oldest);
        clearTimeout(removed.timer);
        removed.controller.abort();
        this.rankings.delete(oldest);
      }
    }
    const matching = {
      backend: "codex",
      status: entry.status,
      ...(entry.error ? { error: entry.error } : {}),
    };
    if (entry.status !== "ready")
      return candidates.map((o) => ({ ...o, matching }));
    return entry.choices.map((choice) => ({
      ...candidates.find((o) => o.id === choice.id),
      matching,
      agentReason: choice.reason,
    }));
  }
  close() {
    for (const entry of this.rankings.values()) {
      clearTimeout(entry.timer);
      entry.controller.abort();
    }
    this.runtime.close?.();
  }
}
