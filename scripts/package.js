import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const marketplace = join(root, 'output/marketplace');
const destination = join(marketplace, 'plugins/star-gazer');
await mkdir(marketplace, { recursive: true });
// Only our generated package is replaced. Profiles and credentials are never copied.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const path of ['.codex-plugin', '.mcp.json', '.env.example', 'src', 'web', 'skills', 'templates', 'examples', 'scripts', 'test', 'docs', 'package.json', 'package-lock.json', 'LICENSE', 'README.md', 'node_modules']) {
  await cp(join(root, path), join(destination, path), { recursive: true, verbatimSymlinks: true });
}
await mkdir(join(marketplace, '.agents/plugins'), { recursive: true });
await writeFile(join(marketplace, '.agents/plugins/marketplace.json'), JSON.stringify({
  name: 'star-gazer-local', interface: { displayName: 'Star Gazer' },
  plugins: [{ name: 'star-gazer', source: { source: 'local', path: './plugins/star-gazer' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }],
}, null, 2) + '\n');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
console.log(`Packaged Star Gazer ${pkg.version} with dependencies at ${resolve(marketplace)}`);
console.log('No credentials or private profiles included.');
