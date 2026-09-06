// M25 Sales Brain — versioned schema migrations.
//
// Stored as TS string constants, not standalone .sql files: electron-vite's
// build only transpiles .ts/.js, so a bare .sql file under src/ would silently
// never make it into the packaged out/ directory (this app's build excludes
// `src/*` from the final package entirely — see electron-builder.yml). Given
// this codebase's own history of subtle packaging bugs (asar corruption from
// stray files, native addons needing explicit unpack rules), the simplest
// thing that can't go wrong is not introducing a new asset-loading path at
// all — a plain exported string is just TS, bundled the same way every other
// module already is.
//
// Applied in order, tracked via SQLite's built-in `PRAGMA user_version`
// (an integer already baked into every SQLite file — no separate "migrations
// table" needed). See db.ts's `migrate()` for how these are actually run:
// each one applies inside a single transaction, and the WHOLE DB FILE is
// backed up before ANY migration in the batch starts, so a failure at
// migration N always leaves either the fully-migrated-to-N-1 file or a
// restored pre-migration file — never a half-applied one.
export interface Migration {
  version: number
  description: string
  sql: string
}

const MIGRATION_001: Migration = {
  version: 1,
  description: 'Initial schema — memories table + sqlite-vec vector index',
  sql: `
CREATE TABLE memories (
  rowid_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL,
  scope TEXT NOT NULL,
  category TEXT NOT NULL,
  statement TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  importance INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'hypothesis',
  source TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  invalidated_by TEXT,
  created_at TEXT NOT NULL,
  last_confirmed_at TEXT NOT NULL,
  invalidated_at TEXT
);

CREATE UNIQUE INDEX idx_memories_id ON memories(id);
CREATE INDEX idx_memories_scope ON memories(scope);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_category ON memories(category);

CREATE VIRTUAL TABLE vec_memories USING vec0(embedding float[384]);
`
}

const MIGRATION_002: Migration = {
  version: 2,
  description: 'Phase 2 — compiled_profiles table (L4 working memory: micro/standard/full per scope)',
  sql: `
CREATE TABLE compiled_profiles (
  scope TEXT NOT NULL,
  size TEXT NOT NULL,
  text TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (scope, size)
);
`
}

const MIGRATION_003: Migration = {
  version: 3,
  description: 'M27 — backfill_attempts: which calls the import has already tried, so a run interrupted by quota exhaustion resumes instead of restarting',
  sql: `
CREATE TABLE backfill_attempts (
  call_id TEXT PRIMARY KEY,
  attempted_at TEXT NOT NULL,
  outcome TEXT NOT NULL
);
`
}

/** Ordered ascending by version — db.ts applies whichever versions are
 *  greater than the DB's current `user_version`, in this order. Adding a new
 *  migration later: append a new `MIGRATION_00N` here, never edit an
 *  already-shipped one (a shipped migration is immutable — anyone who
 *  already applied it has that exact SQL baked into their file; changing it
 *  retroactively would make the same version number mean two different
 *  things depending on when a user installed). */
const MIGRATION_004: Migration = {
  version: 4,
  description:
    'M36 Stage 3 item 4 — last_retrieved_at: usage-aware decay. The founder (2026-09-06): a fact retrieved every week decaying like one never touched is wrong. Nullable; existing rows keep NULL and decay exactly as before until they are next retrieved.',
  sql: `
ALTER TABLE memories ADD COLUMN last_retrieved_at TEXT;
`
}

export const MIGRATIONS: Migration[] = [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
