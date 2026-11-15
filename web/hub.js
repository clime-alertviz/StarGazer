import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./server/store.js";
import { Community } from "./server/community.js";
import { serveMcp } from "./server/mcp.js";
import { pump } from "./server/delivery.js";
import { clientAddressResolver } from "./server/client-address.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
async function readBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 100000)
      throw new Error("Request is too large.");
  }
  return JSON.parse(text || "{}");
}
const assets = new Set([
  "/planning-window.js",
  "/timing.js",
  "/hub.js",
  "/hub.css",
  "/style.css",
  "/shell.js",
  "/fx.js",
  "/graphics.js",
  "/favicon.svg",
  "/autocomplete.js",
  "/profile-editor.js",
  "/join-panel.js",
  "/location.js",
]);

export async function createHub({
  directory = process.env.STAR_GAZER_DATA_DIR ||
    resolve(root, "private/web"),
  port = Number(process.env.PORT || 4317),
  host = process.env.HOST || "127.0.0.1",
  baseUrl = process.env.STAR_GAZER_BASE_URL,
  trustedProxies = process.env.STAR_GAZER_TRUSTED_PROXIES || "",
  geo,
  forecast,
  providers,
  solver,
  solvers,
  seed = false,
} = {}) {
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !baseUrl)
    throw new Error("Set STAR_GAZER_BASE_URL before exposing the service.");
  const clientAddress = clientAddressResolver(trustedProxies);
  const store = await new Store(directory).load(),
    hub = new Community(store, {
      geo,
      forecast,
      providers,
      solver,
      solvers,
    });
  const local =
    ["127.0.0.1", "localhost", "::1"].includes(host) && !baseUrl;
  if (
    !local &&
    (!process.env.SMTP_URL || !process.env.MAIL_FROM) &&
    !providers
  ) {
    store.close();
    throw new Error(
      "Hosted sign-in requires SMTP_URL and MAIL_FROM. Configure email before starting the hosted service.",
    );
  }
  let origin;
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const expected = new URL(origin),
        allowedHosts = local
          ? [
              `127.0.0.1:${server.address().port}`,
              `localhost:${server.address().port}`,
            ]
          : [expected.host];
      if (!allowedHosts.includes(req.headers.host))
        return json(res, 403, {
          error: "Use the configured Star Gazer address.",
        });
      const requestOrigin = local ? `http://${req.headers.host}` : origin;
      if (req.headers.origin && req.headers.origin !== requestOrigin)
        return json(res, 403, {
          error: "Cross-origin requests are not allowed.",
        });
      if (!req.url?.startsWith("/") || req.url.startsWith("//"))
        return json(res, 400, { error: "Invalid request path." });
      const url = new URL(req.url, origin),
        cookies = Object.fromEntries(
          (req.headers.cookie || "")
            .split(";")
            .map((s) => s.trim().split("=")),
        );
      const cookieName = `sg_session_${server.address().port}`,
        session = hub.identity.session(cookies[cookieName]),
        bearer = hub.identity.bearer(
          req.headers.authorization?.replace(/^Bearer /, ""),
        );
      const identity = bearer || session;
      const secure = expected.protocol === "https:" ? "; Secure" : "";
      if (
        req.method === "GET" &&
        (url.pathname === "/" ||
          /^\/outing\/[a-f0-9-]+$/.test(url.pathname) ||
          ["/signin", "/outbox", "/settings"].includes(url.pathname) ||
          assets.has(url.pathname))
      ) {
        const file = assets.has(url.pathname) ? url.pathname : "/hub.html",
          data = await readFile(
            resolve(
              root,
              ["/planning-window.js", "/timing.js"].includes(file)
                ? "src" + file
                : "web/public" + file,
            ),
          );
        res.writeHead(200, {
          "Content-Type":
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
            }[extname(file)] + "; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        return res.end(data);
      }
      if (req.method === "GET" && url.pathname === "/api/bootstrap")
        return json(res, 200, {
          user: session
            ? {
                id: session.userId,
                email: hub.user(session.userId).email,
              }
            : null,
          csrf: session?.csrf,
          local,
          providerSetup: hub.providers.status(session?.userId),
        });
      if (req.method === "GET" && url.pathname === "/api/public-outings")
        return json(res, 200, hub.publicOutings());
      const publicMatch = url.pathname.match(
        /^\/api\/public-outings\/([a-f0-9-]+)$/,
      );
      if (req.method === "GET" && publicMatch) {
        const preview = hub.publicOuting(publicMatch[1]);
        return preview
          ? json(res, 200, preview)
          : json(res, 404, {
              error: "No public preview is available for this outing.",
            });
      }
      if (req.method === "GET" && url.pathname === "/api/local-outbox") {
        if (!local || req.headers["sec-fetch-site"] === "cross-site")
          return json(res, 403, {
            error: "Local outbox is available only on the loopback server.",
          });
        return json(res, 200, hub.data.messages);
      }
      if (
        req.method === "GET" &&
        url.pathname === "/auth/google/callback"
      ) {
        await hub.providers.callback(
          url.searchParams.get("state") || "",
          url.searchParams.get("code") || "",
        );
        res.writeHead(303, { Location: "/?view=settings" });
        return res.end();
      }
      if (req.method !== "POST")
        return json(res, 404, { error: "Not found." });
      if (!bearer && req.headers.origin !== requestOrigin)
        return json(res, 403, {
          error: "Open Star Gazer to continue.",
        });
      const data = await readBody(req);
      if (url.pathname === "/auth/request") {
        const result = await hub.identity.request(
          data.email,
          data.returnTo,
          clientAddress(req),
        );
        setImmediate(() => pump(hub).catch(() => {}));
        return json(res, 200, result);
      }
      if (url.pathname === "/auth/confirm") {
        const result = await hub.identity.confirm(data.token);
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${result.session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`,
        );
        return json(res, 200, {
          user: { id: result.user.id, email: result.user.email },
          csrf: result.csrf,
          returnTo: result.returnTo,
        });
      }
      if (
        !identity &&
        url.pathname === "/mcp" &&
        (["initialize", "notifications/initialized", "tools/list"].includes(
          data.method,
        ) ||
          (data.method === "tools/call" &&
            data.params?.name === "request_signin"))
      )
        return serveMcp(hub, null, req, res, data, clientAddress(req));
      if (!identity) {
        res.setHeader("WWW-Authenticate", 'Bearer realm="StarGazer"');
        return json(res, 401, {
          error: "Sign in to Star Gazer or configure your MCP token.",
        });
      }
      if (!bearer && req.headers["x-stargazer-csrf"] !== session.csrf)
        return json(res, 403, {
          error: "Reload this page to refresh your session.",
        });
      if (url.pathname === "/auth/logout") {
        hub.data.sessions = hub.data.sessions.filter((s) => s !== session);
        await store.persist();
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/${secure}`,
        );
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/auth/mcp-token")
        return json(res, 200, await hub.identity.issue(identity.userId));
      if (url.pathname === "/auth/revoke-mcp") {
        hub.data.tokens = hub.data.tokens.filter(
          (t) => !(t.kind === "mcp" && t.userId === identity.userId),
        );
        await store.persist();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/auth/disconnect-google") {
        hub.data.grants = hub.data.grants.filter(
          (g) => g.userId !== identity.userId,
        );
        await store.persist();
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/mcp")
        return await serveMcp(
          hub,
          identity.userId,
          req,
          res,
          data,
          clientAddress(req),
        );
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      if (error.status === 429 && Number.isInteger(error.retryAfter)) {
        res.setHeader("Retry-After", String(error.retryAfter));
        return json(res, 429, {
          error: error.message,
          retryAfter: error.retryAfter,
        });
      }
      return json(res, 400, {
        error: error.issues
          ? error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")
          : error.message,
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  origin = (baseUrl || `http://127.0.0.1:${server.address().port}`).replace(
    /\/$/,
    "",
  );
  hub.setBase(origin);
  const { migrateLegacy } = await import("./server/migrate.js");
  await migrateLegacy(hub);
  if (seed) {
    const { seedCommunity } = await import("./server/seed.js");
    await seedCommunity(hub);
  }
  const timer = setInterval(
    () => pump(hub, { sync: true }).catch(() => {}),
    60000,
  );
  timer.unref();
  return {
    hub,
    store,
    server,
    url: origin,
    close: async () => {
      clearInterval(timer);
      hub.closing = true;
      hub.solvers.close();
      await hub.planningJobs.close();
      await new Promise((resolve) => server.close(resolve));
      await hub.pumpRun;
      await Promise.allSettled([...hub.deliveryRuns.values()]);
      await store.writes;
      store.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createHub({
    seed: process.env.STAR_GAZER_SEED === "1",
  });
  process.stdout.write(`Star Gazer: ${app.url}\nMCP: ${app.url}/mcp\n`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
