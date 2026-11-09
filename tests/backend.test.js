/** Tests use temporary SQLite files and fake downloads, never the live dataset. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { connect } from "../app/database.js";
import { createApp } from "../app/main.js";
import { sync, download, normalize } from "../app/import-data.js";

/** t.after guarantees cleanup even when an assertion fails. */
async function setup(t) {
  const folder = await mkdtemp(join(tmpdir(), "tick-test-"));
  const dbPath = join(folder, "test.sqlite3");
  const db = connect(dbPath);
  t.after(async () => {
    db.close();
    await rm(folder, { recursive: true, force: true });
  });
  const file = join(folder, "records.json");
  return {
    folder,
    dbPath,
    db,
    client: request(createApp(db)),
    ingest: async (records) => {
      await writeFile(file, JSON.stringify(records));
      return sync({ file, dbPath });
    },
  };
}

/** The spread operator lets each test override only the fields it wants to exercise. */
function row(id = "a", changes = {}) {
  return {
    id,
    date: "2024-01-15T12:00:00",
    location: "London",
    species: "Example tick",
    latinName: "Example species",
    ...changes,
  };
}

test("duplicate IDs are counted, first valid row wins, repeat imports are idempotent", async (t) => {
  const { client, ingest } = await setup(t);
  const records = [
    row(),
    row(),
    row("a", { species: "Changed" }),
    row("b", { species: null }),
  ];
  const result = await ingest(records);
  assert.equal(result.accepted, 2);
  assert.equal(result.duplicates, 2);
  assert.equal(result.conflicting_duplicates, 1);
  assert.equal(result.incomplete, 1);
  await ingest(records);
  assert.equal((await client.get("/api/v1/sightings")).body.total, 2);
  assert.equal(
    (await client.get("/api/v1/sightings/a")).body.species,
    "Example tick",
  );
});

test("filtering, inclusive end dates, pagination and region counts", async (t) => {
  const { client, ingest } = await setup(t);
  await ingest([
    row(),
    row("b", { location: " glasgow ", date: "2024-02-01T23:59:59Z" }),
  ]);
  assert.equal(
    (await client.get("/api/v1/sightings?location=GLASGOW&end=2024-02-01")).body
      .total,
    1,
  );
  assert.equal(
    (await client.get("/api/v1/sightings?start=2024-02-02")).body.total,
    0,
  );
  const page = (await client.get("/api/v1/sightings?limit=1&offset=1")).body;
  assert.equal(page.total, 2);
  assert.equal(page.items[0].id, "a");
  assert.equal(
    (await client.get("/api/v1/reports/regions")).body.items.length,
    2,
  );
  assert.equal(
    (await client.get("/api/v1/reports/trends?region=Scotland")).body.items[0]
      .sightings,
    1,
  );
});

test("weekly buckets start on Monday including across a year boundary", async (t) => {
  const { client, ingest } = await setup(t);
  await ingest([
    row("a", { date: "2023-01-01T12:00:00" }),
    row("b", { date: "2023-01-02T12:00:00" }),
  ]);
  assert.deepEqual(
    (await client.get("/api/v1/reports/trends?interval=weekly")).body.items,
    [
      { period_start: "2022-12-26", sightings: 1 },
      { period_start: "2023-01-02", sightings: 1 },
    ],
  );
});

// Each query gets its own test so failures show the exact validation case.
for (const query of [
  "start=2024-02-01&end=2024-01-01",
  "limit=201",
  "offset=-1",
  "start=invalid",
  "start=2024-02-30",
  "limit=1.5",
  "limit=1&limit=2",
  "location=",
  "start=0000-01-01",
]) {
  test(`invalid query is rejected: ${query}`, async (t) => {
    const { client } = await setup(t);
    assert.equal((await client.get("/api/v1/sightings?" + query)).status, 422);
  });
}

test("SQL-looking text remains a value, and missing records return 404", async (t) => {
  const { client, ingest } = await setup(t);
  await ingest([row()]);
  assert.equal(
    (await client.get("/api/v1/sightings").query({ location: "' OR 1=1 --" }))
      .body.total,
    0,
  );
  assert.equal((await client.get("/api/v1/sightings/missing")).status, 404);
});

for (const [label, bad] of [
  ["empty", []],
  ["object", {}],
  ["invalid date", [row("a", { date: "bad" })]],
  ["null row", [null]],
]) {
  test(`failed refresh preserves previous snapshot: ${label}`, async (t) => {
    const { client, ingest } = await setup(t);
    await ingest([row()]);
    await assert.rejects(ingest(bad));
    assert.equal((await client.get("/api/v1/sightings")).body.total, 1);
    const quality = (await client.get("/api/v1/data-quality")).body;
    assert.equal(quality.latest_attempt.status, "failed");
    assert.equal(quality.latest_success.status, "success");
  });
}

test("incomplete usable records survive, unknown geography is explicit, bad rows are counted", async (t) => {
  const { client, ingest } = await setup(t);
  const records = Array.from({ length: 10 }, (_, i) => row(String(i)));
  records.push(
    row("unknown", { location: "Unmapped village", latinName: null }),
    { id: "broken" },
  );
  const result = await ingest(records);
  assert.equal(result.rejected, 1);
  assert.equal(result.unknown_region, 1);
  assert.deepEqual(result.rejection_reasons, { missing_required_field: 1 });
  assert.equal(
    (await client.get("/api/v1/sightings/unknown")).body.region,
    "Unknown",
  );
});

test("refresh replaces old IDs and normalizes timezones to UTC", async (t) => {
  const { client, ingest } = await setup(t);
  await ingest([row()]);
  await ingest([row("b", { date: "2024-02-01T00:30:00+01:00" })]);
  assert.equal((await client.get("/api/v1/sightings/a")).status, 404);
  assert.equal(
    (await client.get("/api/v1/sightings/b")).body.date,
    "2024-01-31T23:30:00Z",
  );
});

for (const value of [
  "2024-02-30T12:00:00",
  "2024-01-01T24:00:00",
  "9999-01-01T00:00:00",
  "2024-01-01T00:00:00+99:00",
]) {
  test(`invalid or future source date is rejected: ${value}`, () => {
    assert.throws(() => normalize(row("a", { date: value })));
  });
}

test("truncated JSON rolls back records already parsed", async (t) => {
  const { folder, dbPath, client, ingest } = await setup(t);
  await ingest([row()]);
  const file = join(folder, "broken.json");
  await writeFile(file, "[" + JSON.stringify(row("new")) + ",");
  await assert.rejects(sync({ file, dbPath }));
  assert.equal((await client.get("/api/v1/sightings/a")).status, 200);
  assert.equal((await client.get("/api/v1/sightings/new")).status, 404);
});

test("retry transient failures, but do not retry 404", async (t) => {
  const { folder } = await setup(t);
  let calls = 0;
  const waits = [];
  const fetcher = async () =>
    new Response("[]", { status: ++calls < 3 ? 503 : 200 });
  const file = join(folder, "download.json");
  await download(file, { fetcher, wait: async (ms) => waits.push(ms) });
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.equal(await readFile(file, "utf8"), "[]");
  await assert.rejects(
    download(file, {
      fetcher: async () => new Response("", { status: 404 }),
      wait: async (ms) => waits.push(ms),
    }),
  );
  assert.equal(waits.length, 2);
});

test("rate-limit waits are capped and attempts are bounded", async (t) => {
  const { folder } = await setup(t);
  const waits = [];
  await assert.rejects(
    download(join(folder, "download.json"), {
      fetcher: async () =>
        new Response("", { status: 429, headers: { "retry-after": "120" } }),
      wait: async (ms) => waits.push(ms),
    }),
  );
  assert.deepEqual(waits, [60000, 60000]);
});

test("oversize downloads fail without retrying", async (t) => {
  const { folder } = await setup(t);
  let calls = 0;
  await assert.rejects(
    download(join(folder, "download.json"), {
      maxBytes: 5,
      fetcher: async () => {
        calls++;
        return new Response("123456");
      },
    }),
    /safety limit/,
  );
  assert.equal(calls, 1);
});

test("download timeout retries at most three times", async (t) => {
  const { folder } = await setup(t);
  let calls = 0;
  await assert.rejects(
    download(join(folder, "download.json"), {
      timeoutMs: 5,
      wait: async () => {},
      fetcher: (url, { signal }) =>
        new Promise((resolve, reject) => {
          calls++;
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    }),
  );
  assert.equal(calls, 3);
});

test("failed network refresh records its failure and leaves good data available", async (t) => {
  const { client, dbPath, ingest } = await setup(t);
  await ingest([row()]);
  await assert.rejects(
    sync({
      dbPath,
      downloadOptions: {
        fetcher: async () => {
          throw new TypeError("Network unavailable");
        },
        wait: async () => {},
      },
    }),
  );
  assert.equal((await client.get("/api/v1/sightings")).body.total, 1);
  assert.equal(
    (await client.get("/api/v1/data-quality")).body.latest_attempt.status,
    "failed",
  );
});

test("activity windows are adjacent, with transparent percentage and baseline handling", async (t) => {
  const { client, ingest } = await setup(t);
  await ingest([
    ...Array.from({ length: 5 }, (_, i) =>
      row(String(i), { date: "2024-01-01T00:00:00" }),
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      row(String(i + 5), { date: "2024-01-08T00:00:00" }),
    ),
    row("g", { location: "Glasgow", date: "2024-01-08T00:00:00" }),
  ]);
  const result = (
    await client.get(
      "/api/v1/insights/activity-change?as_of=2024-01-14&window_days=7",
    )
  ).body;
  const london = result.items.find((item) => item.region === "London");
  const scotland = result.items.find((item) => item.region === "Scotland");
  assert.equal(london.percent_change, 100);
  assert.equal(london.interpretation, "increase");
  assert.equal(scotland.percent_change, null);
  assert.equal(scotland.interpretation, "insufficient baseline");
  assert.equal(
    (await client.get("/api/v1/insights/activity-change?as_of=0001-01-01"))
      .status,
    422,
  );
  assert.equal(
    (await client.get("/api/v1/insights/activity-change")).status,
    422,
  );
});

test("empty state and interactive API documentation are available", async (t) => {
  const { client } = await setup(t);
  assert.equal((await client.get("/health")).body.data_ready, false);
  assert.equal(
    (await client.get("/api/v1/data-quality")).body.refresh_overdue,
    true,
  );
  assert.equal(
    (await client.get("/api/v1/reports/trends?interval=daily")).status,
    422,
  );
  assert.equal((await client.get("/docs/")).status, 200);
  assert.equal(
    Object.keys((await client.get("/openapi.json")).body.paths).length,
    7,
  );
});

test("separate readers see only committed snapshots", async (t) => {
  const { db, dbPath, client, ingest } = await setup(t);
  await ingest([row()]);
  const writer = connect(dbPath);
  try {
    writer.exec("BEGIN IMMEDIATE; DELETE FROM sightings;");
    assert.equal((await client.get("/api/v1/sightings")).body.total, 1);
    writer.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sightings").get().n, 1);
  } finally {
    writer.close();
  }
});
