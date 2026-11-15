import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { createHub } from "../web/hub.js";

const servers = JSON.parse(
  execFileSync("codex", ["mcp", "list", "--json"], { encoding: "utf8" }),
);
const server = servers.find((s) => s.name === "star_gazer");
assert.ok(server?.enabled, "Install star-gazer@star-gazer-local first");
const cfg = server.transport;
assert.equal(cfg.type, "stdio");
assert.ok(
  cfg.args.some((arg) => arg.endsWith("remote-client.js")),
  "Rebuild and reinstall StarGazer 0.4 before this check.",
);
assert.ok(
  ["STAR_GAZER_URL", "STAR_GAZER_TOKEN"].every((key) =>
    cfg.env_vars.includes(key),
  ),
);
const directory = await mkdtemp(join(tmpdir(), "stargazer-install-"));
const app = await createHub({
  directory,
  port: 0,
  providers: {
    status: () => ({
      googleConfigured: false,
      googleConnected: false,
      email: "local_outbox",
    }),
    mail: async () => ({ delivery: "local_only" }),
  },
});
const user = app.hub.identity.user("organizer@fixture.test");
const { token } = await app.hub.identity.issue(user.id);
const client = new Client({
  name: "star-gazer-install-check",
  version: "0.4.0",
});
const transport = new StdioClientTransport({
  command: cfg.command,
  args: cfg.args,
  cwd: cfg.cwd,
  env: {
    PATH: process.env.PATH || "",
    STAR_GAZER_URL: app.url,
    STAR_GAZER_TOKEN: token,
  },
  stderr: "pipe",
});
const trace = [];
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(result.isError), false, result.content?.[0]?.text);
  const value = JSON.parse(result.content[0].text);
  trace.push({ tool: name, arguments: args, result: value });
  return value;
}
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, "0.4.0");
  const tools = (await client.listTools()).tools;
  for (const name of [
    "request_signin",
    "begin_planning",
    "register_planning_site",
    "check_plan_candidate",
    "save_plan_candidate",
    "claim_connector_delivery",
    "record_connector_delivery",
    "import_calendar_responses",
  ])
    assert.ok(
      tools.some((tool) => tool.name === name),
      `Missing installed tool: ${name}`,
    );
  const me = await call("get_state");
  assert.equal(me.user.id, user.id);
  const test = await call("send_connection_test", {
    guestEmail: "guest@fixture.test",
    start: new Date(Date.now() + 2 * 86400000).toISOString(),
    timezone: "America/New_York",
    channel: "email",
  });
  assert.equal(test.status, "invited");
  assert.equal(test.timezone, "America/New_York");
  await call("add_comment", {
    outingId: test.id,
    text: "Testing the shared service through the installed Codex package.",
  });
  const cancelled = await call("cancel_outing", {
    outingId: test.id,
    reason: "Local installation check complete.",
  });
  assert.equal(cancelled.status, "cancelled");
  const providerCounts = {};
  for (const [name, count] of [
    ["geoapify", 5],
    ["star_gazer_sky", 2],
  ]) {
    const installed = servers.find((s) => s.name === name);
    assert.ok(installed?.enabled, `Missing provider MCP: ${name}`);
    const c = new Client({
      name: "provider-install-check",
      version: "0.4.0",
    });
    try {
      await c.connect(
        new StdioClientTransport({
          command: installed.transport.command,
          args: installed.transport.args,
          cwd: installed.transport.cwd,
          env: { PATH: process.env.PATH },
          stderr: "pipe",
        }),
      );
      providerCounts[name] = (await c.listTools()).tools.length;
      assert.equal(providerCounts[name], count);
      if (name === "star_gazer_sky") {
        const start = new Date(Date.now() + 86400000).toISOString(),
          end = new Date(Date.parse(start) + 3600000).toISOString();
        const result = await c.callTool({
          name: "calculate_astronomy",
          arguments: {
            location: { lat: 50.1, lon: 14.4 },
            start,
            end,
            target: "Moon",
          },
        });
        assert.equal(Boolean(result.isError), false);
        assert.equal(result.structuredContent.source, "Astronomy Engine");
      }
    } finally {
      await c.close();
    }
  }
  const report = {
    checkedAt: new Date().toISOString(),
    status: "passed",
    version: "0.4.0",
    installedDirectory: resolve(cfg.cwd),
    toolCount: tools.length,
    independentProviderTools: providerCounts,
    checks: [
      "Installed stdio adapter connects to authenticated HTTP MCP",
      "Independent Geoapify and sky MCPs advertise their own provider tools",
      "Same user and SQLite records in GUI/service and Codex",
      "Email connection test, comment and cancellation through installed tools",
    ],
    providers:
      "Local provider fixtures; this check does not exercise external delivery",
  };
  await mkdir("output", { recursive: true });
  await writeFile(
    "output/install-checks.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  const redacted = JSON.stringify(
    {
      recordedAt: report.checkedAt,
      mode: "isolated local fixture",
      prompt:
        "Show my outings, send an email connection test to my second test account, add a comment, and cancel it.",
      steps: trace,
    },
    null,
    2,
  )
    .replaceAll(user.id, "account-organizer")
    .replaceAll(app.url, "http://localhost:PORT");
  await writeFile(
    "examples/generated/community-mcp-trace.json",
    redacted + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
