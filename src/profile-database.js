import { DatabaseSync } from 'node:sqlite';
import { profile } from './schema.js';

// The website is the only writer. MCP reads the same records in a short snapshot.
export function loadDatabaseProfiles(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT data FROM profiles ORDER BY rowid').all();
    if (!rows.length || rows.length > 8) throw new Error('Create 1–8 profiles in the Star Gazer web app first.');
    return rows.map(row => profile.parse(JSON.parse(row.data).profile));
  } finally { db.close(); }
}
