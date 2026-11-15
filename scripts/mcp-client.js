import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

export async function connectLocal({ demo = true, serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url)) } = {}) {
  const client = new Client({ name: 'star-gazer-reviewer', version: '0.3.0' });
  const env = { PATH: process.env.PATH ?? '', ...(demo ? { STAR_GAZER_DEMO: '1' } : {}) };
  if (!demo) for (const key of ['GEOAPIFY_API_KEY', 'OPEN_METEO_API_KEY', 'STAR_GAZER_PROFILES_DIR']) if (process.env[key]) env[key] = process.env[key];
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env, stderr: 'pipe' });
  await client.connect(transport);
  return client;
}

export async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  if (result.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text ?? `${name} failed`);
  return result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text);
}
