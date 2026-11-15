import { mkdir, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { profile } from '../../src/schema.js';

const profileEntry = z.object({
  profile,
  displayPlace: z.string().min(1).max(180),
  avatar: z.enum(['saturn', 'moon', 'comet', 'star']).default('saturn'),
  invitationChannel: z.enum(['email', 'calendar']).default('email'),
}).strict();

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.state = { profiles: [], organizerId: null, outings: [] };
    this.writes = Promise.resolve();
  }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.path = join(this.directory, 'stargazer.sqlite');
    this.db = new DatabaseSync(this.path);
    await chmod(this.path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outings (id TEXT PRIMARY KEY, saved_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.state = {
      profiles: this.db.prepare('SELECT data FROM profiles ORDER BY rowid').all().map(row => JSON.parse(row.data)),
      outings: this.db.prepare('SELECT data FROM outings ORDER BY saved_at DESC').all().map(row => JSON.parse(row.data)),
      organizerId: this.db.prepare("SELECT value FROM settings WHERE key='organizerId'").get()?.value || null,
    };
    this.local = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='local'").get()?.value || 'null') || {
      secret: randomBytes(32).toString('hex'), accounts: [], tokens: [], sessions: [], outbox: [],
    };
    this.community = JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='community'").get()?.value || 'null') || {
      version: 1, users: [], connections: [], outings: [], messages: [], sessions: [], tokens: [], grants: [], oauth: [], audit: [],
    };
    // An interrupted invitation must be reconciled, never silently retried.
    for (const outing of this.state.outings) if (outing.invitation?.status === 'sending') outing.invitation.status = 'uncertain';
    for (const outing of this.state.outings) if (outing.coordination?.calendarDelivery === 'sending') outing.coordination.calendarDelivery = 'uncertain';
    return this;
  }
  async persist() {
    const snapshot = structuredClone(this.state);
    const local = JSON.stringify(this.local);
    const community = JSON.stringify(this.community);
    const write = this.writes.then(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec('DELETE FROM profiles; DELETE FROM outings;');
        const saveProfile = this.db.prepare('INSERT INTO profiles (id,email,data) VALUES (?,?,?)');
        for (const entry of snapshot.profiles) saveProfile.run(entry.profile.id,entry.profile.email,JSON.stringify(entry));
        const saveOuting = this.db.prepare('INSERT INTO outings (id,saved_at,data) VALUES (?,?,?)');
        for (const outing of snapshot.outings) saveOuting.run(outing.id,outing.savedAt,JSON.stringify(outing));
        this.db.prepare("INSERT INTO settings (key,value) VALUES ('organizerId',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(snapshot.organizerId || '');
        this.db.prepare("INSERT INTO settings (key,value) VALUES ('local',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(local);
        this.db.prepare("INSERT INTO settings (key,value) VALUES ('community',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(community);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
    this.writes = write.catch(() => {});
    await write;
  }
  async saveProfile(input) {
    const entry = profileEntry.parse(input);
    const other = this.state.profiles.filter(p => p.profile.id !== entry.profile.id);
    if (other.length >= 8) throw new Error('Your circle can contain up to eight profiles.');
    if (other.some(p => p.profile.email.toLowerCase() === entry.profile.email.toLowerCase())) throw new Error('That email already belongs to someone in your circle.');
    this.state.profiles = [...other, entry];
    this.state.organizerId ??= entry.profile.id;
    await this.persist();
    return entry;
  }
  async removeProfile(id) {
    this.state.profiles = this.state.profiles.filter(p => p.profile.id !== id);
    if (this.state.organizerId === id) this.state.organizerId = this.state.profiles[0]?.profile.id ?? null;
    await this.persist();
  }
  async addOuting(plan, input, summary = '') {
    const outing = { id: randomUUID(), plan, input, summary, savedAt: new Date().toISOString(), invitation: null };
    this.state.outings.unshift(outing);
    // Invitations and their audit history must survive new planning searches.
    await this.persist();
    return outing;
  }
  close() { this.db.close(); }
}
