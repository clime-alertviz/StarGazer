import assert from 'node:assert/strict';
import { readFile, stat, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const required = [
  'LICENSE', 'README.md', '.env.example', '.mcp.json',
  'docs/walkthrough.md', 'docs/index.html', 'docs/showcase.mp4',
  'docs/showcase-poster.jpg', 'docs/showcase.en.srt', 'docs/showcase.en.vtt',
  'docs/ai-workflow.md', 'docs/geoapify-feedback.md', 'docs/release.md',
  'examples/README.md', 'examples/requests.md', 'skills/star-gazer/SKILL.md',
  'examples/generated/client-solver-live-check.json',
  'examples/generated/solver-live-check.json',
  'examples/generated/providers-live-check.json',
  'examples/generated/community-mcp-trace.json',
];
for (const file of required) assert.ok((await stat(resolve(root, file))).size > 0, `Empty: ${file}`);
assert.match(await readFile(resolve(root, 'LICENSE'), 'utf8'), /MIT License/);
assert.equal(pkg.license, 'MIT');
const video = await readFile(resolve(root, 'docs/showcase.mp4'));
assert.equal(video.subarray(4, 8).toString(), 'ftyp', 'Walkthrough is not an MP4');
assert.ok(video.length < 100 * 1024 * 1024, 'Video exceeds the ordinary GitHub file limit');

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  .toString().split('\0').filter(Boolean);
let checkedLinks = 0;
for (const file of files.filter(f => f.endsWith('.md') && (f === 'README.md' || f.startsWith('docs/') || f === 'examples/README.md'))) {
  let text;
  try { text = await readFile(resolve(root, file), 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const link = match[1];
    if (/^(?:[a-z]+:|#)/i.test(link)) continue;
    const target = decodeURIComponent(link.split('#')[0]);
    if (!target) continue;
    await access(resolve(root, dirname(file), target)).catch(() => { throw new Error(`Broken link in ${file}: ${target}`); });
    checkedLinks++;
  }
}
for (const file of ['README.md', 'docs/walkthrough.md', 'docs/index.html']) {
  assert.match(await readFile(resolve(root, file), 'utf8'), /https:\/\/www\.geoapify\.com\//, `Missing Geoapify link: ${file}`);
}
const tutorial = await readFile(resolve(root, 'docs/index.html'), 'utf8');
for (const match of tutorial.matchAll(/(?:href|src|poster)="([^"]+)"/g)) {
  if (/^(?:[a-z]+:|#)/i.test(match[1])) continue;
  await access(resolve(root, 'docs', decodeURIComponent(match[1].split('#')[0])));
  checkedLinks++;
}
// Compare local secret values without printing them or their matching contents.
let env = '';
try { env = await readFile(resolve(root, '.env'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const secrets = env.split('\n').flatMap(line => {
  const match = line.match(/^([A-Z_]*(?:KEY|TOKEN|SECRET)|SMTP_URL)=(.*)$/);
  if (!match) return [];
  const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  return value.length >= 12 ? [value] : [];
});
const textExtensions = /\.(?:md|js|json|html|css|py|txt|ya?ml|toml|srt|vtt)$|(?:^|\/)LICENSE$|\.env\.example$/;
for (const file of [...new Set(files.filter(f => textExtensions.test(f)))]) {
  let contents;
  try { contents = await readFile(resolve(root, file), 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
  assert.ok(!secrets.some(secret => contents.includes(secret)), `Local credential found in publishable file: ${file}`);
}
const forbidden = files.filter(f => /(^|\/)(?:\.env$|private\/|node_modules\/)|\.sqlite(?:-wal|-shm)?$/.test(f));
assert.deepEqual(forbidden, [], 'Runtime files must not be published');
console.log(`Submission ${pkg.version}: required files, MIT license, ${checkedLinks} local links, Geoapify backlinks, video size and local-secret exclusion passed.`);
