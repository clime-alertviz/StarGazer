import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { demoScenario } from '../src/demo-data.js';
import { planInput } from '../src/schema.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const json = async path => JSON.parse(await readFile(`${root}/${path}`, 'utf8'));
const pkg = await json('package.json'), legacy = await json('.codex-plugin/plugin.json');
assert.equal(pkg.name, legacy.name); assert.equal(pkg.version, legacy.version);
for (const path of ['LICENSE', 'README.md', 'skills/star-gazer/SKILL.md', 'src/server.js', 'templates/profile.md']) await access(`${root}/${path}`);
const server = (await json('.mcp.json')).mcpServers.star_gazer;
assert.equal(server.args[0], './src/remote-client.js');
assert.equal(server.cwd, './');
const inherited = (await json('.mcp.json')).mcpServers.star_gazer.env_vars;
assert.ok(['STAR_GAZER_URL', 'STAR_GAZER_TOKEN'].every(key => inherited.includes(key)));
assert.ok(!(await json('.mcp.json')).mcpServers.star_gazer.env);
for (const [name, group] of [['geoapify','geoapify'],['star_gazer_sky','sky']]) {
  const config=(await json('.mcp.json')).mcpServers[name];
  assert.deepEqual(config.args,['./src/provider-server.js',group]);
  assert.ok(!config.env);
}
const skill = await readFile(`${root}/skills/star-gazer/SKILL.md`, 'utf8');
assert.ok(skill.startsWith('---\nname: star-gazer\n'));
planInput.parse(await demoScenario());
console.log('Plugin manifests, skill paths, MCP configuration and sample profiles validated.');
