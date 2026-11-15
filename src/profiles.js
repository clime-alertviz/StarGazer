import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { profile } from './schema.js';

export async function loadProfiles(directory) {
  const files = (await readdir(directory, { withFileTypes: true })).filter(f => f.isFile() && f.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name));
  if (!files.length || files.length > 8) throw new Error('Use a directory containing 1–8 Markdown participant profiles.');
  const profiles = [];
  for (const file of files) {
    const text = await readFile(join(directory, file.name), 'utf8');
    if (text.length > 20000) throw new Error(`Profile ${file.name} exceeds 20 KB`);
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error(`Profile ${file.name} needs YAML frontmatter`);
    try { profiles.push(profile.parse(parseYaml(match[1]))); }
    catch { throw new Error(`Profile ${file.name} is invalid. Compare its fields with templates/profile.md.`); }
  }
  if (new Set(profiles.map(p => p.id)).size !== profiles.length || new Set(profiles.map(p => p.email.toLowerCase())).size !== profiles.length) throw new Error('Participant IDs and emails must be unique.');
  return profiles;
}
