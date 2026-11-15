const allowed = ['geocode_address', 'list_place_categories', 'search_places', 'calculate_route_matrix', 'calculate_route'];

export class Geoapify {
  constructor({ apiKey = process.env.GEOAPIFY_API_KEY, fetchImpl = fetch, trace = () => {} } = {}) {
    this.apiKey = apiKey; this.fetch = fetchImpl; this.trace = trace; this.sequence = 0;
  }
  async rpc(method, params) {
    if (!this.apiKey) throw new Error('GEOAPIFY_API_KEY is missing. Export it before starting Codex, or run npm run demo.');
    const id = ++this.sequence;
    let response;
    try {
      response = await this.fetch('https://api.geoapify.com/v1/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', 'x-api-key': this.apiKey },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(25000),
      });
    } catch { throw new Error('Geoapify MCP could not be reached. Retry later.'); }
    if (!response.ok) throw new Error(`Geoapify MCP returned HTTP ${response.status}. Check your key, quota and connectivity.`);
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Geoapify MCP returned invalid JSON. Retry later; the response body was not logged.'); }
    if (body.error || body.result?.isError || !body.result) throw new Error(`Geoapify MCP ${params?.name ?? method} failed. Check inputs against get_geoapify_tools; no route was assumed.`);
    return body.result;
  }
  async list() {
    const result = await this.rpc('tools/list');
    return { tools: result.tools.filter(t => allowed.includes(t.name)) };
  }
  async call(name, args) {
    if (!allowed.includes(name)) throw new Error('Unsupported Geoapify tool');
    const result = await this.rpc('tools/call', { name, arguments: args });
    let data = result.structuredContent;
    if (!data) {
      try { data = JSON.parse(result.content.find(c => c.type === 'text').text); }
      catch { throw new Error(`Geoapify ${name} did not return structured JSON`); }
    }
    this.trace({ provider: 'Geoapify MCP', tool: name, arguments: args, result: data });
    return data;
  }
}

export function matrixCell(matrix, row, column) {
  if (matrix.time_units !== 'seconds' || matrix.distance_units !== 'meters') throw new Error('Geoapify route matrix units must be seconds and meters');
  const c = matrix.sources_to_targets?.[row]?.[column];
  if (!c || !Number.isFinite(c.time) || c.time < 0 || !Number.isFinite(c.distance) || c.distance < 0) return null;
  return { minutes: Math.ceil(c.time / 60), distanceMeters: c.distance };
}

export function routeSummary(data) {
  if (data.time_units !== 'seconds' || data.distance_units !== 'meters' || !Number.isFinite(data.time) || data.time < 0 || !Number.isFinite(data.distance) || data.distance < 0) throw new Error('Geoapify detailed route has missing or unexpected time/distance units');
  return { minutes: Math.ceil(data.time / 60), distanceMeters: data.distance };
}

export function routeLegSummaries(data, count) {
  const total = routeSummary(data);
  if (count === 1 && !data.legs) return [total];
  if (data.legs?.length !== count) throw new Error('Geoapify must return one leg per stopover pair for pickup timing');
  const legs = data.legs.map(leg => routeSummary({ ...leg, time_units: data.time_units, distance_units: data.distance_units }));
  // Preserve any larger total estimate rather than silently losing unallocated time.
  legs[0].minutes += Math.max(0, total.minutes - legs.reduce((sum, leg) => sum + leg.minutes, 0));
  return legs;
}

export function navigationLink(site, mode, waypoints = []) {
  const modes = { drive: 'driving', ride: 'driving', walk: 'walking', bicycle: 'bicycling' };
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1'); url.searchParams.set('destination', `${site.meetingPoint.lat},${site.meetingPoint.lon}`); url.searchParams.set('travelmode', modes[mode]);
  if (waypoints.length) url.searchParams.set('waypoints', waypoints.map(p => `${p.lat},${p.lon}`).join('|'));
  return url.href;
}
