import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "./providers.js";

export class Identity {
  constructor(store, send) {
    this.store = store;
    this.data = store.community;
    this.send = send;
    this.rates = new Map();
    this.clientRates = new Map();
  }
  cleanup(now = Date.now()) {
    this.data.tokens = this.data.tokens.filter((t) => t.expires > now);
    this.data.sessions = this.data.sessions.filter((t) => t.expires > now);
    this.data.oauth = this.data.oauth.filter((t) => t.expires > now);
    this.data.messages = this.data.messages.filter((m) =>
      m.kind === "signin" || m.link?.startsWith(`${this.baseUrl}/signin#`)
        ? (m.expires || Date.parse(m.createdAt) + 900000) > now
        : ["queued", "sending", "uncertain", "failed"].includes(
            m.delivery,
          ) || Date.parse(m.createdAt) > now - 30 * 86400000,
    );
    for (const [map, window] of [
      [this.rates, 60000],
      [this.clientRates, 3600000],
    ])
      for (const [key, times] of map)
        if (times.at(-1) <= now - window) map.delete(key);
  }
  async request(address, returnTo = "/", client = "local") {
    const email = z.email().max(254).parse(address).toLowerCase();
    if (
      !/^\/(?:outing\/[a-f0-9-]+|\?view=(?:circle|outings|settings|profile|plan))?$/.test(
        returnTo,
      )
    )
      returnTo = "/";
    const now = Date.now();
    this.cleanup(now);
    const [local, domain] = email.split("@");
    const rateKey = `${local.split("+")[0]}@${domain}`;
    const recent = (this.rates.get(rateKey) || []).filter(
      (t) => t > now - 60000,
    );
    const clients = (this.clientRates.get(client) || []).filter(
      (t) => t > now - 3600000,
    );
    // Bound each sender and recipient, never consume a shared sign-in quota.
    // Account existence does not affect either the limit or the response.
    const blockedUntil = Math.max(
      0,
      ...[
        [recent, 3, 60000],
        [clients.filter((t) => t > now - 60000), 10, 60000],
        [clients, 100, 3600000],
      ]
        .filter(([times, limit]) => times.length >= limit)
        .map(
          ([times, limit, window]) => times[times.length - limit] + window,
        ),
    );
    if (blockedUntil > now) {
      const retryAfter = Math.ceil((blockedUntil - now) / 1000);
      throw Object.assign(
        new Error(
          `Too many sign-in requests. No new email was queued. Try again in ${retryAfter} seconds.`,
        ),
        { status: 429, retryAfter },
      );
    }
    clients.push(now);
    this.clientRates.set(client, clients);
    recent.push(now);
    this.rates.set(rateKey, recent);
    const token = randomBytes(32).toString("hex");
    this.data.tokens = this.data.tokens.filter((t) => t.expires > now);
    this.data.tokens.push({
      hash: digest(token),
      email,
      kind: "signin",
      returnTo,
      expires: now + 900000,
    });
    this.send({
      kind: "signin",
      expires: now + 900000,
      to: email,
      subject: "Your Star Gazer sign-in link",
      text: "Click Continue on the sign-in page. Opening this link alone does not use it. It expires in 15 minutes.",
      link: `${this.baseUrl}/signin#${token}`,
    });
    await this.store.persist();
    return {
      message:
        "Check your inbox for a sign-in link. In local mode, open the local outbox.",
    };
  }
  user(email) {
    let user = this.data.users.find((u) => u.email === email.toLowerCase());
    if (!user) {
      user = {
        id: randomUUID(),
        email: email.toLowerCase(),
        createdAt: new Date().toISOString(),
        preferences: null,
      };
      this.data.users.push(user);
    }
    return user;
  }
  async confirm(token) {
    z.string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(token);
    const record = this.data.tokens.find(
      (t) =>
        t.hash === digest(token) &&
        t.kind === "signin" &&
        t.expires > Date.now(),
    );
    if (!record)
      throw new Error(
        "This link expired or was already used. Request a new one.",
      );
    this.data.tokens = this.data.tokens.filter((t) => t !== record);
    const user = this.user(record.email),
      session = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex");
    this.data.sessions = this.data.sessions.filter(
      (s) => s.expires > Date.now(),
    );
    this.data.sessions.push({
      hash: digest(session),
      userId: user.id,
      csrf,
      expires: Date.now() + 7 * 86400000,
    });
    await this.store.persist();
    return { session, csrf, user, returnTo: record.returnTo || "/" };
  }
  session(token) {
    return (
      token &&
      this.data.sessions.find(
        (s) => s.hash === digest(token) && s.expires > Date.now(),
      )
    );
  }
  bearer(token) {
    return (
      token &&
      this.data.tokens.find(
        (t) =>
          t.hash === digest(token) &&
          t.kind === "mcp" &&
          t.expires > Date.now(),
      )
    );
  }
  async issue(userId) {
    const token = randomBytes(32).toString("hex");
    this.data.tokens = this.data.tokens.filter(
      (t) => !(t.userId === userId && t.kind === "mcp"),
    );
    this.data.tokens.push({
      hash: digest(token),
      userId,
      kind: "mcp",
      expires: Date.now() + 90 * 86400000,
    });
    await this.store.persist();
    return { token, expiresInDays: 90, endpoint: `${this.baseUrl}/mcp` };
  }
}
