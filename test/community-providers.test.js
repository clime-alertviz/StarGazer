import test from "node:test";
import assert from "node:assert/strict";
import { Providers } from "../web/server/providers.js";
import { createServer } from "node:net";

function fixture(identity = "owner@fixture.test") {
  const calls = [],
    store = {
      local: { secret: "fixture-secret" },
      community: {
        users: [{ id: "owner", email: "owner@fixture.test" }],
        grants: [],
        oauth: [],
      },
      persist: async () => {},
    };
  const provider = new Providers(store, {
    env: {
      GOOGLE_CLIENT_ID: "fixture-client",
      GOOGLE_CLIENT_SECRET: "fixture-client-secret",
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      let data;
      if (url.includes("/userinfo"))
        data = { email: identity, email_verified: true };
      else
        data = {
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          expires_in: 3600,
        };
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  provider.baseUrl = "http://127.0.0.1:4317";
  return { provider, store, calls };
}

test("OAuth uses PKCE, one-time state, verified identity and encrypted offline credentials", async () => {
  const f = fixture(),
    connection = await f.provider.connect("owner"),
    url = new URL(connection.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:4317/auth/google/callback",
  );
  const state = url.searchParams.get("state");
  assert.ok(!JSON.stringify(f.store.community.oauth).includes(state));
  await f.provider.callback(state, "fixture-code");
  assert.equal(f.store.community.grants.length, 1);
  assert.ok(
    !JSON.stringify(f.store.community.grants).includes("fixture-refresh"),
  );
  assert.equal(await f.provider.token("owner"), "fixture-access");
  await assert.rejects(
    () => f.provider.callback(state, "fixture-code"),
    /expired/,
  );
});

test("OAuth rejects a different Google account and modified encrypted tokens", async () => {
  const f = fixture("wrong@fixture.test"),
    connection = await f.provider.connect("owner");
  await assert.rejects(
    () =>
      f.provider.callback(
        new URL(connection.url).searchParams.get("state"),
        "fixture-code",
      ),
    /same Google email/,
  );
  assert.equal(f.store.community.grants.length, 0);
  const sealed = f.provider.seal({ refresh_token: "private" }),
    bytes = Buffer.from(sealed, "base64");
  bytes[15] ^= 1;
  assert.throws(() => f.provider.unseal(bytes.toString("base64")));
});

test("SMTP absent and fixture recipients remain local; provider diagnostics never echo secret response bodies", async () => {
  const f = fixture();
  assert.equal(
    (await f.provider.mail({ to: "guest@fixture.test" })).delivery,
    "local_only",
  );
  f.provider.fetch = async () =>
    new Response(JSON.stringify({ error: "sensitive provider body" }), {
      status: 401,
    });
  await assert.rejects(
    () => f.provider.json("https://example.invalid"),
    (error) =>
      !error.message.includes("sensitive provider body") &&
      error.status === 401,
  );
});

test("SMTP delivers the composed invitation through a real local mail sink", async (t) => {
  let message = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write("220 local.fixture ESMTP\r\n");
    let buffer = "",
      data = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const end = buffer.indexOf("\r\n"),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          } else message += line + "\r\n";
        } else if (/^EHLO/.test(line))
          socket.write("250-local.fixture\r\n250 SIZE 1000000\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 send message\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
        else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const f = fixture(),
    p = new Providers(f.store, {
      env: {
        SMTP_URL: `smtp://127.0.0.1:${server.address().port}`,
        MAIL_FROM: "StarGazer <sender@fixture.invalid>",
      },
    });
  const result = await p.mail({
    to: "guest@fixture.invalid",
    subject: "Your evening",
    text: "Review the plan",
    link: "http://127.0.0.1:4317/outing/fixture",
  });
  assert.equal(result.delivery, "sent");
  assert.match(message, /To: guest@fixture.invalid/);
  assert.match(message, /Review the plan/);
  assert.match(message, /\/outing\/fixture/);
});

test("authorized Gmail composes the page link and Calendar updates notify guests using the same event", async () => {
  const f = fixture();
  f.store.community.users[0].email = "owner@fixture.invalid";
  f.store.community.grants.push({
    userId: "owner",
    data: f.provider.seal({
      access_token: "fixture-access",
      expires: Date.now() + 3600000,
    }),
  });
  assert.equal(
    (
      await f.provider.mail({
        to: "guest@fixture.invalid",
        senderId: "owner",
        subject: "Evening",
        text: "Hello",
        link: "http://127.0.0.1:4317/outing/fixture",
      })
    ).delivery,
    "sent",
  );
  const sent = f.calls.find((c) => c.url.includes("messages/send")),
    mime = Buffer.from(
      JSON.parse(sent.options.body).raw,
      "base64url",
    ).toString();
  assert.match(mime, /To: guest@fixture.invalid/);
  assert.match(mime, /\/outing\/fixture/);
  await f.provider.calendar(
    "owner",
    "PATCH",
    "same-event",
    { summary: "Updated" },
    "etag-1",
  );
  const update = f.calls.at(-1);
  assert.match(update.url, /same-event\?sendUpdates=all/);
  assert.equal(update.options.headers["If-Match"], "etag-1");
  await f.provider.calendar("owner", "DELETE", "same-event");
  assert.equal(f.calls.at(-1).options.method, "DELETE");
  assert.match(f.calls.at(-1).url, /same-event\?sendUpdates=all/);
});

test("Gmail authentication failures fall back to SMTP, but ambiguous sends never duplicate", async () => {
  const f = fixture();
  f.store.community.users[0].email = "owner@fixture.invalid";
  f.store.community.grants.push({
    userId: "owner",
    data: f.provider.seal({
      access_token: "fixture",
      expires: Date.now() + 60000,
      refresh_token: "fixture",
    }),
  });
  f.provider.env.MAIL_FROM = "system@fixture.invalid";
  let smtp = 0;
  f.provider.smtp = {
    sendMail: async () => {
      smtp++;
    },
  };
  f.provider.fetch = async () => new Response("{}", { status: 401 });
  const message = {
    senderId: "owner",
    to: "guest@fixture.invalid",
    subject: "Outing",
    text: "Review",
  };
  assert.equal((await f.provider.mail(message)).delivery, "sent");
  assert.equal(smtp, 1);
  f.store.community.grants[0].data = f.provider.seal({
    access_token: "fixture",
    expires: Date.now() + 3600000,
  });
  f.provider.fetch = async () => {
    throw Error("Timed out after send");
  };
  await assert.rejects(f.provider.mail(message), /Timed out/);
  assert.equal(smtp, 1);
});
