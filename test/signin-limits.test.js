import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Identity } from "../web/server/identity.js";
import { clientAddressResolver } from "../web/server/client-address.js";
import { createHub } from "../web/hub.js";

function fixture() {
  const store = {
    community: {
      tokens: [],
      sessions: [],
      oauth: [],
      users: [],
      messages: [],
    },
    persist: async () => {},
  };
  const identity = new Identity(store, (message) =>
    store.community.messages.push({
      createdAt: new Date(Date.now()).toISOString(),
      delivery: "queued",
      ...message,
    }),
  );
  identity.baseUrl = "http://127.0.0.1:4317";
  return { identity, data: store.community };
}

test("one client exhausting its hourly allowance cannot block other clients", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const { identity, data } = fixture();
  for (let minute = 0; minute < 10; minute++) {
    for (let i = 0; i < 10; i++)
      await identity.request(
        `sender-${minute}-${i}@fixture.test`,
        "/",
        "abusive-client",
      );
    now += 61000;
  }
  await assert.rejects(
    identity.request("one-more@fixture.test", "/", "abusive-client"),
    (error) => error.status === 429 && error.retryAfter > 60,
  );
  assert.equal(data.messages.length, 100);
  await identity.request("legitimate@fixture.test", "/", "another-client");
  assert.equal(data.messages.length, 101);
  now += 3600000;
  await identity.request(
    "after-cooldown@fixture.test",
    "/",
    "abusive-client",
  );
  assert.equal(identity.clientRates.get("abusive-client").length, 1);
  assert.equal(identity.clientRates.has("another-client"), false);
});

test("concurrent requests share only their own client limit and blocked requests queue no email", async () => {
  const { identity, data } = fixture();
  const attempts = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) =>
      identity.request(`concurrent-${i}@fixture.test`, "/", "one-client"),
    ),
  );
  assert.equal(attempts.filter((r) => r.status === "fulfilled").length, 10);
  assert.equal(data.messages.length, 10);
  assert.equal(data.tokens.length, 10);
  for (const r of attempts.filter((r) => r.status === "rejected")) {
    assert.equal(r.reason.status, 429);
    assert.match(r.reason.message, /No new email was queued/);
    assert.ok(r.reason.retryAfter > 0 && r.reason.retryAfter <= 60);
  }
  await identity.request("independent@fixture.test", "/", "other-client");
  assert.equal(data.messages.length, 11);
});

test("proxy resolution trusts configured peers only and stops at the first untrusted hop", () => {
  const request = (peer, forwarded) => ({
    socket: { remoteAddress: peer },
    headers: { "x-forwarded-for": forwarded },
  });
  const direct = clientAddressResolver();
  assert.equal(
    direct(request("::ffff:192.0.2.1", "203.0.113.1")),
    "192.0.2.1",
  );
  assert.equal(
    direct(request("2001:0db8:0:0::1", "not-an-ip")),
    "2001:db8::1",
  );
  const proxy = clientAddressResolver(
    "127.0.0.1, 10.0.0.0/8, 2001:db8:ffff::/48",
  );
  assert.equal(
    proxy(request("::ffff:127.0.0.1", "198.51.100.7, 10.1.2.3")),
    "198.51.100.7",
  );
  assert.equal(
    proxy(request("127.0.0.1", "forged, 203.0.113.9, 10.1.2.3")),
    "203.0.113.9",
  );
  assert.equal(
    proxy(request("2001:db8:ffff::1", "2001:0db8:0:0::2")),
    "2001:db8::2",
  );
  assert.equal(proxy(request("192.0.2.1", "10.0.0.1")), "192.0.2.1");
  assert.throws(
    () => proxy(request("127.0.0.1", undefined)),
    /must supply X-Forwarded-For/,
  );
  assert.throws(() => proxy(request("127.0.0.1", "garbage")), /valid IP/);
  for (const config of [
    "true",
    "127.0.0.1/33",
    "::1/129",
    "10.0.0.0/8/extra",
  ])
    assert.throws(
      () => clientAddressResolver(config),
      /STAR_GAZER_TRUSTED_PROXIES/,
    );
});

async function httpFixture(t, trustedProxies) {
  const directory = await mkdtemp(join(tmpdir(), "sg-signin-proxy-"));
  const app = await createHub({
    directory,
    port: 0,
    trustedProxies,
    providers: {
      status: () => ({ googleConnected: false, email: "local_outbox" }),
      mail: async () => ({ delivery: "local_only" }),
    },
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (email, forwarded) =>
    fetch(app.url + "/auth/request", {
      method: "POST",
      headers: {
        Origin: app.url,
        "Content-Type": "application/json",
        ...(forwarded ? { "X-Forwarded-For": forwarded } : {}),
      },
      body: JSON.stringify({ email }),
    });
  return { app, post };
}

test("HTTP proxy clients have separate allowances and throttling returns 429 with Retry-After", async (t) => {
  const { app, post } = await httpFixture(t, "127.0.0.1");
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await post(`first-${i}@fixture.test`, "203.0.113.1")).status,
      200,
    );
  const blocked = await post("limited@fixture.test", "203.0.113.1");
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(Number(blocked.headers.get("retry-after")), body.retryAfter);
  assert.match(body.error, /No new email was queued/);
  assert.ok(!body.message?.includes("Check your inbox"));
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await post(`second-${i}@fixture.test`, "203.0.113.2")).status,
      200,
    );
  assert.equal(
    (await post("third@fixture.test", "203.0.113.3")).status,
    200,
  );
  assert.equal(app.hub.data.messages.length, 21);
  assert.equal((await post("missing-header@fixture.test")).status, 400);
  assert.equal(app.hub.data.messages.length, 21);
});

test("untrusted forwarded headers cannot rotate the HTTP client's allowance", async (t) => {
  const { app, post } = await httpFixture(t, "");
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await post(`direct-${i}@fixture.test`, `203.0.113.${i + 1}`)).status,
      200,
    );
  assert.equal(
    (await post("forged-header@fixture.test", "198.51.100.1")).status,
    429,
  );
  assert.equal(app.hub.data.messages.length, 10);
});
