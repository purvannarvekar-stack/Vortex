import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "data", "vortex.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    rationale TEXT NOT NULL,
    rejection_log TEXT NOT NULL,   -- JSON array of strings
    sources TEXT NOT NULL,          -- JSON array of strings
    created_at TEXT NOT NULL,       -- ISO-8601 UTC
    cycle_run INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agent_state (
    agent_id TEXT PRIMARY KEY,
    persona_name TEXT NOT NULL,
    persona_domain TEXT NOT NULL,
    status TEXT NOT NULL,
    initialized_at TEXT NOT NULL,   -- ISO-8601 utc
    cycle_end_at TEXT NOT NULL,     -- ISO-8601 utc, end of 48h cycle
    last_run_at TEXT
  );

  CREATE TABLE IF NOT EXISTS seen_stories (
    agent_id TEXT NOT NULL,
    story_url TEXT NOT NULL,
    story_title TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, story_url)
  );

  CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(agent_id, created_at DESC);
`);

const stmts = {
  insertPost: db.prepare(
    `INSERT INTO posts (id, agent_id, title, body, rationale, rejection_log, sources, created_at, cycle_run)
     VALUES (@id, @agent_id, @title, @body, @rationale, @rejection_log, @sources, @created_at, @cycle_run)`
  ),
  getPosts: db.prepare(
    `SELECT * FROM posts WHERE agent_id = ? ORDER BY created_at DESC`
  ),
  getPostCount: db.prepare(
    `SELECT COUNT(*) as c FROM posts WHERE agent_id = ?`
  ),
  upsertAgent: db.prepare(
    `INSERT INTO agent_state (agent_id, persona_name, persona_domain, status, initialized_at, cycle_end_at, last_run_at)
     VALUES (@agent_id, @persona_name, @persona_domain, @status, @initialized_at, @cycle_end_at, @last_run_at)
     ON CONFLICT(agent_id) DO UPDATE SET
       persona_name = excluded.persona_name,
       persona_domain = excluded.persona_domain,
       status = excluded.status,
       initialized_at = excluded.initialized_at,
       cycle_end_at = excluded.cycle_end_at,
       last_run_at = excluded.last_run_at`
  ),
  getAgent: db.prepare(`SELECT * FROM agent_state WHERE agent_id = ?`),
  touchAgent: db.prepare(
    `UPDATE agent_state SET last_run_at = ?, status = ? WHERE agent_id = ?`
  ),
  markSeen: db.prepare(
    `INSERT OR IGNORE INTO seen_stories (agent_id, story_url, story_title, seen_at) VALUES (?, ?, ?, ?)`
  ),
  seenUrls: db.prepare(
    `SELECT story_url FROM seen_stories WHERE agent_id = ?`
  ),
};

export function savePost(post) {
  stmts.insertPost.run({
    id: post.id,
    agent_id: post.agentId,
    title: post.title,
    body: post.body,
    rationale: post.rationale,
    rejection_log: JSON.stringify(post.rejectionLog ?? []),
    sources: JSON.stringify(post.sources ?? []),
    created_at: post.createdAt,
    cycle_run: post.cycleRun ?? 0,
  });
}

export function getPosts(agentId) {
  return stmts.getPosts.all(agentId).map(rowToPost);
}

export function getPostCount(agentId) {
  return stmts.getPostCount.get(agentId).c;
}

export function saveAgent(agent) {
  stmts.upsertAgent.run(agent);
}

export function getAgent(agentId) {
  return stmts.getAgent.get(agentId);
}

export function touchAgent(agentId, status) {
  stmts.touchAgent.run(new Date().toISOString(), status, agentId);
}

export function markSeenStories(agentId, stories) {
  const now = new Date().toISOString();
  const tx = db.transaction((items) => {
    for (const s of items) {
      stmts.markSeen.run(agentId, s.url, s.title, now);
    }
  });
  tx(stories);
}

export function getSeenUrls(agentId) {
  return new Set(stmts.seenUrls.all(agentId).map((r) => r.story_url));
}

function rowToPost(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    body: row.body,
    rationale: row.rationale,
    rejectionLog: JSON.parse(row.rejection_log),
    sources: JSON.parse(row.sources),
    createdAt: row.created_at,
    cycleRun: row.cycle_run,
  };
}

export function closeDb() {
  db.close();
}
