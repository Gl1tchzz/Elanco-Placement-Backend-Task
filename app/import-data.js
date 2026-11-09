/** Download, validate and atomically publish a snapshot. Run with npm run refresh. */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { connect, recordRun } from "./database.js";
import { cleanText, dateOnly, InputError } from "./validation.js";

export const SOURCE = "https://dev-task.elancoapps.com/data/tick-sightings";
const MAX_BYTES = 100 * 1024 * 1024;
const REGIONS = new Map(
  Object.entries({
    London: "London",
    Manchester: "North West",
    Liverpool: "North West",
    Birmingham: "West Midlands",
    Nottingham: "East Midlands",
    Leicester: "East Midlands",
    Leeds: "Yorkshire and the Humber",
    Sheffield: "Yorkshire and the Humber",
    Bristol: "South West",
    Southampton: "South East",
    Newcastle: "North East",
    Glasgow: "Scotland",
    Edinburgh: "Scotland",
    Cardiff: "Wales",
  }),
);
const CITIES = new Map(
  [...REGIONS.keys()].map((city) => [city.toLowerCase(), city]),
);

/** Convert one upstream record into the six database fields, in column order. */
export function normalize(row) {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new InputError("not_an_object");
  const id = cleanText(row.id, true);
  const rawCity = cleanText(row.location, true);
  const city = CITIES.get(rawCity.toLowerCase()) || rawCity;
  const raw = cleanText(row.date, true);
  // Only accept ISO timestamps, checking the calendar date before JS parses the time.
  const parts =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(
      raw,
    );
  try {
    if (!parts) throw new Error();
    dateOnly(parts[1]);
    if (+parts[2] > 23 || +parts[3] > 59 || +parts[4] > 59) throw new Error();
    if (parts[5] && parts[5] !== "Z") {
      const [hours, minutes] = parts[5].slice(1).split(":").map(Number);
      if (hours > 23 || minutes > 59) throw new Error();
    }
  } catch {
    throw new InputError("invalid_date");
  }
  // The source omits timezone information. Treat that as UTC, never the laptop's timezone.
  const stamp = new Date(parts[5] ? raw : `${raw}Z`);
  if (
    !Number.isFinite(stamp.getTime()) ||
    stamp.getUTCFullYear() < 1 ||
    stamp.getUTCFullYear() > 9999
  ) {
    throw new InputError("invalid_date");
  }
  if (stamp > new Date()) throw new InputError("future_date");
  return [
    id,
    stamp.toISOString().slice(0, 19) + "Z",
    city,
    REGIONS.get(city) || "Unknown",
    cleanText(row.species),
    cleanText(row.latinName),
  ];
}

/** Stream to disk with a byte cap, a whole-attempt timeout and three bounded attempts. */
export async function download(
  target,
  {
    fetcher = fetch,
    wait = sleep,
    maxBytes = MAX_BYTES,
    timeoutMs = 30000,
  } = {},
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryAfter = 0;
    try {
      const response = await fetcher(SOURCE, {
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) {
        const header = response.headers.get("retry-after");
        retryAfter = /^\d+$/.test(header || "")
          ? Number(header) * 1000
          : Math.max(0, Date.parse(header) - Date.now()) || 0;
        await response.body?.cancel();
        const error = new Error(`Upstream HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      if (!response.body) throw new Error("Upstream response has no body");
      let size = 0;
      // pipeline respects backpressure: a slow disk cannot create an unbounded queue.
      const limiter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          callback(
            size > maxBytes
              ? new Error("Upstream response exceeds safety limit")
              : null,
            chunk,
          );
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        limiter,
        createWriteStream(target),
        { signal: controller.signal },
      );
      return;
    } catch (error) {
      // Node fetch uses TypeError for network failures; an aborted attempt also retries.
      const retryable =
        error.retryable ??
        (error instanceof TypeError || error.name === "AbortError");
      if (!retryable || attempt === 2) throw error;
      clearTimeout(timer);
      await wait(
        Math.min(
          60000,
          Math.max(1000 * 2 ** attempt + Math.random() * 1000, retryAfter),
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Stage records before replacing the published snapshot, keeping memory bounded per record. */
export async function importSnapshot(path, db) {
  const counts = {
    received: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    conflicting_duplicates: 0,
    incomplete: 0,
    unknown_region: 0,
    rejection_reasons: {},
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TEMP TABLE staging AS SELECT * FROM sightings WHERE 0;
      CREATE UNIQUE INDEX staging_id ON staging(id);`);
    const find = db.prepare("SELECT * FROM staging WHERE id=?");
    const insert = db.prepare("INSERT INTO staging VALUES (?,?,?,?,?,?)");
    // StreamArray rejects non-array input. pipeline also propagates file and parse errors.
    await pipeline(
      createReadStream(path),
      streamArray.withParserAsStream(),
      async function (records) {
        for await (const { value } of records) {
          counts.received++;
          let fields;
          try {
            fields = normalize(value);
          } catch (error) {
            if (!(error instanceof InputError)) throw error;
            counts.rejected++;
            counts.rejection_reasons[error.message] =
              (counts.rejection_reasons[error.message] || 0) + 1;
            continue;
          }
          const old = find.get(fields[0]);
          if (old) {
            counts.duplicates++;
            if (JSON.stringify(Object.values(old)) !== JSON.stringify(fields))
              counts.conflicting_duplicates++;
            continue; // The first valid occurrence of an ID wins within this snapshot.
          }
          insert.run(...fields);
          counts.accepted++;
          if (fields[4] === null || fields[5] === null) counts.incomplete++;
          if (fields[3] === "Unknown") counts.unknown_region++;
        }
      },
    );
    if (!counts.accepted || counts.rejected / counts.received > 0.1) {
      throw new Error(
        "Quality gate failed: empty snapshot or over 10% invalid rows",
      );
    }
    // Readers keep seeing the previous dataset until this whole transaction commits.
    db.exec(
      "DELETE FROM sightings; INSERT INTO sightings SELECT * FROM staging; DROP TABLE staging;",
    );
    recordRun(db, "success", counts);
    db.exec("COMMIT");
    return counts;
  } catch (error) {
    db.exec("ROLLBACK"); // Also removes the temporary table created in this transaction.
    throw error;
  }
}

/** Record failures outside the rolled-back transaction; clean temporary files in every case. */
export async function sync({ file, dbPath, downloadOptions } = {}) {
  const db = connect(dbPath);
  let temporary;
  try {
    if (!file) {
      temporary = await mkdtemp(join(tmpdir(), "tick-atlas-"));
      file = join(temporary, "source.json");
      await download(file, downloadOptions);
    }
    return await importSnapshot(file, db);
  } catch (error) {
    recordRun(db, "failed", {
      error: error.name,
      message: error.message.slice(0, 300),
    });
    throw error;
  } finally {
    db.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}

// Importing this module in tests must not accidentally download the live dataset.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--file")) {
    console.error("Usage: npm run refresh [-- --file path/to/records.json]");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await sync({ file: args[1] }), null, 2));
    } catch (error) {
      console.error(
        `Sync failed; previous snapshot preserved: ${error.message}`,
      );
      process.exitCode = 1;
    }
  }
}
