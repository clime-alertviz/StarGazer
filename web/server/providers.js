import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import nodemailer from "nodemailer";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
const scope =
  "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send";

export class Providers {
  constructor(store, { env = process.env, fetchImpl = fetch } = {}) {
    this.store = store;
    this.env = env;
    this.fetch = fetchImpl;
    this.key = createHash("sha256")
      .update(env.STAR_GAZER_ENCRYPTION_KEY || store.local.secret)
      .digest();
    this.refreshes = new Map();
    this.smtp = env.SMTP_URL
      ? nodemailer.createTransport({
          url: env.SMTP_URL,
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 20000,
        })
      : null;
  }
  seal(value) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    return Buffer.concat([
      iv,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
  }
  unseal(value) {
    const raw = Buffer.from(value, "base64"),
      cipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        raw.subarray(0, 12),
      );
    cipher.setAuthTag(raw.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        cipher.update(raw.subarray(12, -16)),
        cipher.final(),
      ]).toString(),
    );
  }
  status(userId) {
    return {
      googleConfigured: Boolean(
        this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET,
      ),
      googleConnected: Boolean(
        this.store.community.grants.find((g) => g.userId === userId),
      ),
      email: this.smtp ? "smtp" : "local_outbox",
      callback: `${this.baseUrl}/auth/google/callback`,
    };
  }
  async json(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 204) return {};
    let data;
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(
        `Provider request failed (${response.status}). Check the connection and retry from Settings.`,
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }
  async connect(userId) {
    if (!this.status(userId).googleConfigured)
      throw new Error(
        "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart the server. See Settings for the redirect URL.",
      );
    const state = randomBytes(32).toString("hex"),
      verifier = randomBytes(48).toString("base64url");
    this.store.community.oauth = this.store.community.oauth.filter(
      (o) => o.expires > Date.now(),
    );
    this.store.community.oauth.push({
      hash: digest(state),
      userId,
      verifier,
      expires: Date.now() + 600000,
    });
    await this.store.persist();
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    const params = {
      client_id: this.env.GOOGLE_CLIENT_ID,
      redirect_uri: `${this.baseUrl}/auth/google/callback`,
      response_type: "code",
      scope,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256")
        .update(verifier)
        .digest("base64url"),
    };
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return { url: url.href };
  }
  async callback(state, code) {
    const pending = this.store.community.oauth.find(
      (o) => o.hash === digest(state) && o.expires > Date.now(),
    );
    if (!pending)
      throw new Error(
        "The connection request expired. Start again in Settings.",
      );
    this.store.community.oauth = this.store.community.oauth.filter(
      (o) => o !== pending,
    );
    await this.store.persist();
    const tokens = await this.json("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.env.GOOGLE_CLIENT_ID,
        client_secret: this.env.GOOGLE_CLIENT_SECRET,
        code,
        code_verifier: pending.verifier,
        redirect_uri: `${this.baseUrl}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    const identity = await this.json(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    );
    const user = this.store.community.users.find(
      (u) => u.id === pending.userId,
    );
    if (
      !identity.email_verified ||
      identity.email?.toLowerCase() !== user.email
    )
      throw new Error(
        "Connect the same Google email address you used to sign in to Star Gazer.",
      );
    const old = this.store.community.grants.find(
      (g) => g.userId === user.id,
    );
    const refresh =
      tokens.refresh_token || (old && this.unseal(old.data).refresh_token);
    if (!refresh)
      throw new Error(
        "Google did not grant offline access. Remove the previous grant in Google and connect again.",
      );
    this.store.community.grants = this.store.community.grants.filter(
      (g) => g.userId !== user.id,
    );
    this.store.community.grants.push({
      userId: user.id,
      data: this.seal({
        ...tokens,
        refresh_token: refresh,
        expires: Date.now() + tokens.expires_in * 1000,
      }),
    });
    await this.store.persist();
    return user;
  }
  async token(userId) {
    const grant = this.store.community.grants.find(
      (g) => g.userId === userId,
    );
    if (!grant)
      throw new Error(
        "The organizer needs to connect Google in Settings before Calendar invitations can be sent.",
      );
    const data = this.unseal(grant.data);
    if (data.expires > Date.now() + 60000) return data.access_token;
    if (!this.refreshes.has(userId))
      this.refreshes.set(
        userId,
        (async () => {
          const next = await this.json(
            "https://oauth2.googleapis.com/token",
            {
              method: "POST",
              body: new URLSearchParams({
                client_id: this.env.GOOGLE_CLIENT_ID,
                client_secret: this.env.GOOGLE_CLIENT_SECRET,
                refresh_token: data.refresh_token,
                grant_type: "refresh_token",
              }),
            },
          );
          grant.data = this.seal({
            ...data,
            ...next,
            expires: Date.now() + next.expires_in * 1000,
          });
          await this.store.persist();
          return next.access_token;
        })().finally(() => this.refreshes.delete(userId)),
      );
    return this.refreshes.get(userId);
  }
  async calendar(userId, method, eventId, payload, etag) {
    const token = await this.token(userId);
    return this.json(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events${eventId ? `/${encodeURIComponent(eventId)}` : ""}${method !== "GET" ? "?sendUpdates=all" : ""}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(etag ? { "If-Match": etag } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      },
    );
  }
  async mail(message) {
    if (message.to.endsWith(".test")) return { delivery: "local_only" };
    const grant = this.store.community.grants.find(
      (g) => g.userId === message.senderId,
    );
    if (grant) {
      let sending = false;
      try {
        const accessToken = await this.token(message.senderId);
        const user = this.store.community.users.find(
          (u) => u.id === message.senderId,
        );
        const composed = await nodemailer
          .createTransport({ streamTransport: true, buffer: true })
          .sendMail({
            from: user.email,
            to: message.to,
            subject: message.subject,
            text: `${message.text}\n\n${message.link || ""}`,
          });
        sending = true;
        await this.json(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              raw: composed.message.toString("base64url"),
            }),
          },
        );
        return { delivery: "sent", provider: "gmail" };
      } catch (error) {
        // A token failure or explicit rejection cannot have delivered the email.
        // A timeout after sending is uncertain: never risk an SMTP duplicate.
        const rejected =
          error.status >= 400 && error.status < 500 && error.status !== 408;
        if (!this.smtp || (sending && !rejected)) throw error;
      }
    }
    if (!this.smtp) return { delivery: "local_only" };
    if (!this.env.MAIL_FROM)
      throw new Error("Set MAIL_FROM for SMTP delivery.");
    await this.smtp.sendMail({
      from: this.env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: `${message.text}\n\n${message.link || ""}`,
    });
    return { delivery: "sent" };
  }
}
