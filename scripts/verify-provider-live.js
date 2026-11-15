import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const clients = [];
const trace = [];
async function connect(group) {
  const client = new Client({
    name: "stargazer-provider-check",
    version: "0.4.0",
  });
  clients.push(client);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve("src/provider-server.js"), group],
      env: {
        PATH: process.env.PATH,
        ...(process.env.GEOAPIFY_API_KEY
          ? { GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY }
          : {}),
        ...(process.env.OPEN_METEO_API_KEY
          ? { OPEN_METEO_API_KEY: process.env.OPEN_METEO_API_KEY }
          : {}),
      },
      stderr: "pipe",
    }),
  );
  return client;
}
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(Boolean(result.isError), false, result.content?.[0]?.text);
  const data =
    result.structuredContent ?? JSON.parse(result.content[0].text);
  trace.push({ tool: name, status: "passed" });
  return data;
}
try {
  const geo = await connect("geoapify"),
    sky = await connect("sky");
  assert.equal((await geo.listTools()).tools.length, 5);
  assert.equal((await sky.listTools()).tools.length, 2);
  const found = await call(geo, "geocode_address", {
    query: "Slavkov u Brna, Czechia",
    limit: 1,
  });
  const item = (found.features || found.results)[0],
    p = item.properties || item;
  const location = {
    lat: p.lat ?? item.geometry.coordinates[1],
    lon: p.lon ?? item.geometry.coordinates[0],
  };
  const categories = await call(geo, "list_place_categories", {});
  assert.ok(categories.categories.includes("tourism.attraction.viewpoint"));
  const places = await call(geo, "search_places", {
    category: "tourism.attraction.viewpoint",
    ...location,
    radius_meters: 10000,
    limit: 2,
  });
  const destination = {
    lat: location.lat + 0.002,
    lon: location.lon + 0.002,
  };
  const matrix = await call(geo, "calculate_route_matrix", {
    sources: [location],
    targets: [destination],
    mode: "walk",
    units: "metric",
  });
  assert.equal(matrix.time_units, "seconds");
  const route = await call(geo, "calculate_route", {
    waypoints: [location, destination],
    mode: "walk",
    units: "metric",
    geometry_scope: "none",
  });
  assert.ok(route.time > 0);
  const start = new Date(Date.now() + 86400000).toISOString(),
    end = new Date(Date.parse(start) + 3600000).toISOString();
  const forecast = await call(sky, "get_weather_forecast", {
    location,
    start,
    end,
  });
  assert.equal(forecast.source, "Open-Meteo");
  assert.equal(forecast.complete, true);
  const astronomy = await call(sky, "calculate_astronomy", {
    location,
    start,
    end,
    target: "Saturn",
  });
  assert.equal(astronomy.source, "Astronomy Engine");
  const report = {
    checkedAt: new Date().toISOString(),
    status: "passed",
    provenance:
      "Actual independent stdio MCP processes call live Geoapify MCP and Open-Meteo; real Astronomy Engine. No StarGazer database, token or backend LLM.",
    place: p.formatted || p.name,
    viewpoints: (places.features || places.results || places.places || [])
      .length,
    forecastRetrieved: forecast.fetchedAt,
    trace,
  };
  await mkdir("examples/generated", { recursive: true });
  await writeFile(
    "examples/generated/providers-live-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
}
