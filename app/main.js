/** Express receives HTTP requests, reads SQLite and sends JSON answers. */
import express from "express";
import swaggerUi from "swagger-ui-express";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, transaction } from "./database.js";
import { filters, dateOnly, integer, InputError } from "./validation.js";
import { specification } from "./openapi.js";

/** Tests supply an isolated database. Importing this function does not start a server. */
export function createApp(db) {
  const app = express();
  app.disable("x-powered-by");
  app.set("query parser", "simple");
  app.get("/", (req, res) => res.redirect("/docs"));
  app.get("/openapi.json", (req, res) => res.json(specification));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(specification));

  // GET routes read information. No public endpoint can trigger an import or write records.
  app.get("/health", (req, res) => {
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM sightings")
      .get();
    res.json({ status: "ok", data_ready: count > 0, sightings: count });
  });

  app.get("/api/v1/sightings", (req, res) => {
    const { where, params } = filters(req.query);
    const limit = integer(req.query.limit, 50, 1, 200, "limit");
    const offset = integer(req.query.offset, 0, 0, 1000000, "offset");
    // Both queries share one snapshot even if another process refreshes the data.
    res.json(
      transaction(db, () => ({
        total: db
          .prepare("SELECT COUNT(*) AS count FROM sightings" + where)
          .get(...params).count,
        limit,
        offset,
        // Stable tie-breaking by ID prevents records with identical dates changing order.
        items: db
          .prepare(
            "SELECT * FROM sightings" +
              where +
              " ORDER BY date DESC,id LIMIT ? OFFSET ?",
          )
          .all(...params, limit, offset),
      })),
    );
  });

  app.get("/api/v1/sightings/:sighting_id", (req, res) => {
    const row = db
      .prepare("SELECT * FROM sightings WHERE id=?")
      .get(req.params.sighting_id);
    if (!row) return res.status(404).json({ detail: "Sighting not found" });
    res.json(row);
  });

  app.get("/api/v1/reports/regions", (req, res) => {
    const { where, params } = filters(req.query);
    res.json({
      items: db
        .prepare(
          "SELECT region,COUNT(*) AS sightings FROM sightings" +
            where +
            " GROUP BY region ORDER BY sightings DESC,region",
        )
        .all(...params),
      geography:
        "English regions plus Scotland and Wales; unmapped cities are Unknown",
    });
  });

  app.get("/api/v1/reports/trends", (req, res) => {
    const { where, params } = filters(req.query);
    const interval = req.query.interval ?? "monthly";
    if (!["weekly", "monthly"].includes(interval))
      throw new InputError("interval must be weekly or monthly");
    // SQLite calls Sunday day 0. This expression subtracts the number of days since Monday.
    const bucket =
      interval === "monthly"
        ? "strftime('%Y-%m-01',date)"
        : "date(date, '-' || ((CAST(strftime('%w',date) AS INTEGER)+6)%7) || ' days')";
    res.json({
      interval,
      week_starts: "Monday",
      empty_buckets: "omitted",
      items: db
        .prepare(
          `SELECT ${bucket} AS period_start,COUNT(*) AS sightings FROM sightings` +
            where +
            " GROUP BY period_start ORDER BY period_start",
        )
        .all(...params),
    });
  });

  app.get("/api/v1/data-quality", (req, res) => {
    res.json(
      transaction(db, () => {
        const last =
          db
            .prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1")
            .get() || null;
        const good =
          db
            .prepare(
              "SELECT * FROM sync_runs WHERE status='success' ORDER BY id DESC LIMIT 1",
            )
            .get() || null;
        for (const run of [last, good])
          if (run) run.report = JSON.parse(run.report);
        const coverage = db
          .prepare(
            "SELECT COUNT(*) AS sightings,MIN(date) AS earliest,MAX(date) AS latest FROM sightings",
          )
          .get();
        // A recent import can contain old observations; report both ages separately.
        const age = good
          ? Math.round((Date.now() - Date.parse(good.finished_at)) / 1000)
          : null;
        return {
          latest_attempt: last,
          latest_success: good,
          coverage,
          snapshot_age_seconds: age,
          refresh_overdue: age === null || age > 86400,
          notice:
            "Refresh age is separate from observation age. Educational data; not a live risk map.",
        };
      }),
    );
  });

  app.get("/api/v1/insights/activity-change", (req, res) => {
    const asOf = dateOnly(req.query.as_of, "as_of");
    const windowDays = integer(
      req.query.window_days,
      90,
      7,
      365,
      "window_days",
    );
    const day = 86400000;
    const end = Date.parse(`${asOf}T00:00:00Z`);
    const recentStart = new Date(end - (windowDays - 1) * day);
    const previousStart = new Date(recentStart.getTime() - windowDays * day);
    if (previousStart.getUTCFullYear() < 1)
      throw new InputError("as_of is too early for these windows");
    const recent = recentStart.toISOString().slice(0, 10);
    const previous = previousStart.toISOString().slice(0, 10);
    // CASE counts records in each adjacent window without counting a boundary record twice.
    const items = db
      .prepare(
        `SELECT region,
      SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) AS recent,
      SUM(CASE WHEN date < ? THEN 1 ELSE 0 END) AS previous
      FROM sightings WHERE date >= ? AND date <= ? GROUP BY region ORDER BY region`,
      )
      .all(recent, recent, previous, `${asOf}T23:59:59Z`);
    for (const row of items) {
      row.percent_change = row.previous
        ? Math.round(((row.recent - row.previous) / row.previous) * 1000) / 10
        : null;
      // Five reports is a transparent heuristic, not a test of statistical significance.
      row.interpretation =
        row.previous < 5
          ? "insufficient baseline"
          : row.recent > row.previous
            ? "increase"
            : row.recent < row.previous
              ? "decrease"
              : "unchanged";
    }
    res.json({
      as_of: asOf,
      window_days: windowDays,
      recent_start: recent,
      previous_start: previous,
      method:
        "Descriptive comparison; fewer than 5 baseline reports is insufficient. No predictive model or significance claim. Reporting effort and seasonality can change counts.",
      items,
    });
  });

  app.use((req, res) => res.status(404).json({ detail: "Endpoint not found" }));
  // Express recognises an error handler by its four arguments. Never expose internal SQL/errors.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status =
      error instanceof InputError ? 422 : error.status === 400 ? 400 : 500;
    if (status === 500) console.error(error);
    res.status(status).json({
      detail: status === 500 ? "Internal server error" : error.message,
    });
  });
  return app;
}

// Only the npm start command opens a port; tests import createApp directly.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const db = connect();
  const port = integer(process.env.PORT, 8000, 1, 65535, "PORT");
  const server = createApp(db).listen(port, "127.0.0.1", () => {
    console.log(`Tick Atlas UK (Node.js) ready: http://127.0.0.1:${port}/docs`);
  });
  server.on("error", (error) => {
    console.error(error.message);
    db.close();
    process.exitCode = 1;
  });
  // Stop accepting requests, finish existing ones, then close the database cleanly.
  const stop = () =>
    server.close(() => {
      db.close();
      process.exit(0);
    });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
