import { readFileSync } from "node:fs";
import { z } from "zod";
import { Geoapify } from "../geoapify.js";
import { fetchForecast, weatherFields } from "../weather.js";
import { skyAt, assessSky } from "../astronomy.js";
import { instant, location, target } from "../schema.js";

// Provider schemas captured from the actual Geoapify tools/list response. The
// adapter forwards individual calls unchanged; upstream validates its own inputs.
const catalog = JSON.parse(
  readFileSync(new URL("./geoapify-tools.json", import.meta.url), "utf8"),
);
export function geoapifyTools(geo = new Geoapify()) {
  const tools = catalog.tools.map((t) => ({
    ...t,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  }));
  return {
    tools,
    async callTool(name, args) {
      if (!tools.some((t) => t.name === name))
        throw new Error("Unknown Geoapify tool.");
      return geo.call(name, args);
    },
  };
}

const period = z
  .object({ location, start: instant, end: instant })
  .strict();
function bounds(args, maxDays) {
  const start = Date.parse(args.start),
    end = Date.parse(args.end);
  if (end <= start || end - start > maxDays * 86400000)
    throw new Error(
      `End must follow start; request at most ${maxDays} days at a time.`,
    );
  return { start, end };
}
export function skyTools({
  forecast = fetchForecast,
  now = () => Date.now(),
} = {}) {
  const definitions = {
    get_weather_forecast: {
      description:
        "Read hourly Open-Meteo forecast values for coordinates and a time range (up to seven days, within fifteen days). Returns source, retrieval time, coverage and explicit units; no site or time is chosen for you. Null/missing values are not good weather.",
      schema: period,
      run: async (args) => {
        const { start, end } = bounds(args, 7);
        if (start < now() - 3600000 || end > now() + 15 * 86400000)
          throw new Error(
            "Request a current or future forecast within fifteen days.",
          );
        const data = await forecast(args.location);
        const from = Math.floor(start / 3600000) * 3600000;
        const expected = Math.ceil((end - from) / 3600000);
        const hours = data.hours.filter(
          (h) => Date.parse(h.at) >= from && Date.parse(h.at) < end,
        );
        const required = [
          "cloud_cover",
          "wind_speed_10m",
          "temperature_2m",
          "precipitation_probability",
          "precipitation",
          "visibility",
        ];
        const timestamps = new Set(hours.map((h) => Date.parse(h.at)));
        return {
          source: data.source,
          fetchedAt: data.fetchedAt,
          location: args.location,
          start: args.start,
          end: args.end,
          complete:
            Array.from(
              { length: expected },
              (_, i) => from + i * 3600000,
            ).every((t) => timestamps.has(t)) &&
            hours.every((h) =>
              required.every((k) => Number.isFinite(h[k])),
            ),
          units: {
            time: "UTC",
            cloud_cover: "%",
            cloud_cover_low: "%",
            cloud_cover_mid: "%",
            cloud_cover_high: "%",
            wind_speed_10m: "km/h",
            temperature_2m: "°C",
            precipitation_probability: "%",
            precipitation: "mm",
            visibility: "m",
          },
          hours: hours.map((h) =>
            Object.fromEntries(
              ["at", ...weatherFields].map((k) => [k, h[k] ?? null]),
            ),
          ),
        };
      },
    },
    calculate_astronomy: {
      description:
        "Calculate Sun/Moon/target altitude and azimuth, lunar illumination and darkness for coordinates and a window up to two days. Includes 15-minute samples and the standard sky assessment. This is Astronomy Engine calculation, independent of weather. Level horizon; no terrain, night-access or light-pollution claim.",
      schema: period.extend({ target }).strict(),
      run: (args) => {
        const { start, end } = bounds(args, 2);
        if (
          new Date(start).getUTCFullYear() < 1900 ||
          new Date(end).getUTCFullYear() > 2100
        )
          throw new Error("Use dates from 1900 through 2100.");
        const samples = [];
        for (let at = start; at < end; at += 15 * 60000)
          samples.push(skyAt(args.location, at, args.target));
        samples.push(skyAt(args.location, end, args.target));
        return {
          source: "Astronomy Engine",
          calculatedAt: new Date(now()).toISOString(),
          location: args.location,
          target: args.target,
          units: {
            time: "UTC",
            altitude: "degrees",
            azimuth: "degrees",
            moonIllumination: "fraction 0–1",
          },
          assumptions:
            "Level horizon; trees, terrain, light pollution and access are not assessed.",
          assessment: assessSky(args.location, start, end, args.target),
          samples,
        };
      },
    },
  };
  return {
    tools: Object.entries(definitions).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.schema),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: name === "get_weather_forecast",
      },
    })),
    async callTool(name, args) {
      const t = definitions[name];
      if (!t) throw new Error("Unknown weather/astronomy tool.");
      return t.run(t.schema.parse(args));
    },
  };
}
