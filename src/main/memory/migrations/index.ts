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

/** M36 Stage 3 item 2 — the lexical channel's store half. An FTS5 index over
 *  `memories.statement`, kept in step by triggers, so a proper noun ("Okafor",
 *  "Tellus", "Marseille") can be found by STRING when the embedding has no
 *  meaning to match on (see lexical-terms.ts for the measured gap). It is an
 *  external-content table: the text lives in `memories` and nowhere else, the
 *  index stores tokens and positions only — nothing new is stored about the
 *  user, and dropping the table plus its triggers restores the previous file
 *  exactly. The closing `rebuild` indexes every row that already exists, so
 *  a user upgrading with 2,000 memories can find them by name the moment the
 *  migration returns. `unicode61 remove_diacritics 2`: case-folded, accent-
 *  insensitive ("Jose" finds "José"), no stemming, no prefixes. */
const MIGRATION_005: Migration = {
  version: 5,
  description:
    'M36 Stage 3 item 2 — memories_fts: FTS5 lexical index over memories.statement (external content, trigger-maintained, rebuilt over existing rows) so names, products and places retrieve by string beside the vector channel',
  sql: `
CREATE VIRTUAL TABLE memories_fts USING fts5(
  statement,
  content='memories',
  content_rowid='rowid_pk',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, statement) VALUES (new.rowid_pk, new.statement);
END;

CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, statement) VALUES ('delete', old.rowid_pk, old.statement);
END;

CREATE TRIGGER memories_fts_au AFTER UPDATE OF statement ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, statement) VALUES ('delete', old.rowid_pk, old.statement);
  INSERT INTO memories_fts(rowid, statement) VALUES (new.rowid_pk, new.statement);
END;

INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
`
}

export const MIGRATIONS: Migration[] = [MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005]

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version
