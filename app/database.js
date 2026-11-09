/** SQLite stores sightings and import history in one local file. */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

/** Tests pass their own path, so they never change the real dataset. */
export function connect(
  path = process.env.DATABASE_PATH ||
    resolve(projectRoot, "data/ticks.sqlite3"),
) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL allows the server to read the previous snapshot while the import job writes.
  db.exec(`
    PRAGMA busy_timeout=30000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS sightings (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, location TEXT NOT NULL,
      region TEXT NOT NULL, species TEXT, latin_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_date ON sightings(date, id);
    CREATE INDEX IF NOT EXISTS idx_location_nocase_date ON sightings(location COLLATE NOCASE, date);
    CREATE INDEX IF NOT EXISTS idx_region_nocase_date ON sightings(region COLLATE NOCASE, date);
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY, finished_at TEXT NOT NULL, status TEXT NOT NULL, report TEXT NOT NULL
    );
  `);
  return db;
}

/** Finish all related statements together, or undo them all if any statement fails. */
export function transaction(db, operation) {
  db.exec("BEGIN");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** The import report is stored as JSON text so its counters can be returned later. */
export function recordRun(db, status, report) {
  db.prepare(
    "INSERT INTO sync_runs(finished_at,status,report) VALUES (?,?,?)",
  ).run(new Date().toISOString(), status, JSON.stringify(report));
}
