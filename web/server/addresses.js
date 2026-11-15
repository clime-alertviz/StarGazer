import { z } from "zod";
import { location } from "../../src/schema.js";
export const addressQuery = z
  .object({
    query: z.string().trim().min(3).max(200),
    bias: location.optional(),
    country: z
      .string()
      .regex(/^[a-z]{2}$/)
      .optional(),
  })
  .strict();
export class Addresses {
  constructor(geo) {
    this.geo = geo;
    this.cache = new Map();
  }
  async request(endpoint, params) {
    if (!this.geo.apiKey)
      throw new Error("Address search needs GEOAPIFY_API_KEY on the server.");
    const url = new URL(`https://api.geoapify.com/v1/geocode/${endpoint}`);
    for (const [k, v] of Object.entries({
      ...params,
      format: "json",
      apiKey: this.geo.apiKey,
    }))
      url.searchParams.set(k, String(v));
    const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!response.ok)
      throw new Error(
        "Address suggestions are unavailable. Try again shortly.",
      );
    return (await response.json()).results || [];
  }
  async search(raw) {
    const d = addressQuery.parse(raw);
    if (this.geo.autocomplete) return this.geo.autocomplete(d);
    const key = JSON.stringify(d),
      old = this.cache.get(key);
    if (old && Date.now() - old.at < 300000) return old.promise;
    const promise = (async () => {
      const params = { text: d.query, limit: 8 };
      if (d.bias) params.bias = `proximity:${d.bias.lon},${d.bias.lat}`;
      if (d.country) params.filter = `countrycode:${d.country}`;
      // Short prefixes should look nearby first, without excluding an explicitly typed town.
      let rows = [];
      if (d.bias && d.query.length < 7 && !d.query.includes(","))
        rows = await this.request("autocomplete", {
          ...params,
          filter: `circle:${d.bias.lon},${d.bias.lat},35000`,
        });
      if (!rows.length) rows = await this.request("autocomplete", params);
      return rows.map((p) => ({
        name: p.formatted,
        location: { lat: p.lat, lon: p.lon },
      }));
    })();
    this.cache.set(key, { at: Date.now(), promise });
    if (this.cache.size > 100)
      this.cache.delete(this.cache.keys().next().value);
    try {
      return await promise;
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
  }
  async nearby(raw) {
    const point = location.parse(raw);
    if (this.geo.nearby) return this.geo.nearby(point);
    const rows = await this.request("reverse", {
      ...point,
      type: "city",
      limit: 1,
    });
    if (!rows.length)
      throw new Error(
        "We could not identify the nearby town. Type a town or public place.",
      );
    const p = rows[0];
    return {
      country: p.country_code,
      area: p.city || p.town || p.formatted,
      point: { name: p.formatted, location: { lat: p.lat, lon: p.lon } },
    };
  }
}
