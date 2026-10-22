// Self-hosted SQLite store (Node's built-in node:sqlite — no native deps).
// Users, sessions, games, and the community layer: per-move commentary
// revisions (wiki-style, engine-seeded), discussion comments, votes, the
// points ledger, and linked game-server accounts.

import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.KOMI_DB_PATH || path.join(__dirname, 'komi.db');

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS games (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL,
    title      TEXT NOT NULL,
    sgf        TEXT NOT NULL,
    analysis   TEXT,                      -- JSON FullGameAnalysis (optional)
    is_public  INTEGER NOT NULL DEFAULT 1, -- public by default
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_games_owner  ON games(owner_id);
  CREATE INDEX IF NOT EXISTS idx_games_public ON games(is_public);
`);

// ---------------------------------------------------------------------------
// Migrations. node:sqlite has no ADD COLUMN IF NOT EXISTS, so check
// table_info first; everything here must stay idempotent because it runs on
// every boot (including against the long-lived production DB on its disk).
// ---------------------------------------------------------------------------

function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    return true;
  }
  return false;
}

// --- users: public identity, reputation, role ---
ensureColumn('users', 'username', 'TEXT');
ensureColumn('users', 'points', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'user'");
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
         ON users(username) WHERE username IS NOT NULL`);

// --- games: review-queue state + library metadata ---
// status: pending -> analyzing -> ready | failed. Default 'ready' so the
// backfill below only has to demote rows that never got an analysis.
const addedStatus = ensureColumn('games', 'status', "TEXT NOT NULL DEFAULT 'ready'");
ensureColumn('games', 'source', 'TEXT');          // upload|ogs|kgs|fox|curated|client
ensureColumn('games', 'analysis_error', 'TEXT');
ensureColumn('games', 'analysis_progress', 'REAL NOT NULL DEFAULT 0');
ensureColumn('games', 'analysis_phase', 'TEXT');  // queued|engine|semantic|deep
ensureColumn('games', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('games', 'next_attempt_at', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('games', 'analysis_started_at', 'INTEGER');
ensureColumn('games', 'black_name', 'TEXT');
ensureColumn('games', 'white_name', 'TEXT');
ensureColumn('games', 'black_rank', 'TEXT');
ensureColumn('games', 'white_rank', 'TEXT');
db.exec('CREATE INDEX IF NOT EXISTS idx_games_status ON games(status)');

if (addedStatus) {
  // One-time backfill: rows saved before the queue existed keep their
  // client-computed analysis ('ready'); rows without one get queued.
  db.exec(`UPDATE games SET source = COALESCE(source, 'client') WHERE analysis IS NOT NULL`);
  db.exec(`UPDATE games SET status = 'pending', analysis_progress = 0, analysis_phase = 'queued'
           WHERE analysis IS NULL`);
}

// --- community layer ---
db.exec(`
  CREATE TABLE IF NOT EXISTS linked_accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    server     TEXT NOT NULL CHECK (server IN ('ogs','kgs','fox')),
    handle     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, server),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Wiki-style per-move commentary. author_id NULL = the engine's seed
  -- revision. The displayed revision is the most-voted (ties -> newest);
  -- the full chain is the edit history / future training corpus.
  CREATE TABLE IF NOT EXISTS commentary_revisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL,
    move_number INTEGER NOT NULL,
    author_id   INTEGER,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_revisions_game_move
    ON commentary_revisions(game_id, move_number);

  CREATE TABLE IF NOT EXISTS revision_votes (
    revision_id INTEGER NOT NULL,
    voter_id    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY(revision_id, voter_id),
    FOREIGN KEY(revision_id) REFERENCES commentary_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY(voter_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Flat discussion per move, separate from the canonical commentary.
  CREATE TABLE IF NOT EXISTS move_comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER NOT NULL,
    move_number INTEGER NOT NULL,
    author_id   INTEGER NOT NULL,
    body        TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(author_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_comments_game_move
    ON move_comments(game_id, move_number);

  CREATE TABLE IF NOT EXISTS comment_votes (
    comment_id INTEGER NOT NULL,
    voter_id   INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(comment_id, voter_id),
    FOREIGN KEY(comment_id) REFERENCES move_comments(id) ON DELETE CASCADE,
    FOREIGN KEY(voter_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- The game owner's one "insightful" pick per move (+5 to the author).
  CREATE TABLE IF NOT EXISTS insightful_marks (
    game_id     INTEGER NOT NULL,
    move_number INTEGER NOT NULL,
    comment_id  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY(game_id, move_number),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(comment_id) REFERENCES move_comments(id) ON DELETE CASCADE
  );

  -- Append-only reputation ledger; users.points is maintained in the same
  -- transaction as each event so the sum of deltas always equals points.
  CREATE TABLE IF NOT EXISTS point_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    delta      INTEGER NOT NULL,
    reason     TEXT NOT NULL,       -- comment_vote|revision_vote|insightful|...(reversals negate)
    ref_type   TEXT,                -- comment|revision
    ref_id     INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_point_events_user ON point_events(user_id);
`);

export default db;
