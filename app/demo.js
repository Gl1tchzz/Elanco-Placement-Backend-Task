/** Start the server first, then npm run demo prints a short tour of its responses. */
const paths = [
  "/health",
  "/api/v1/sightings?location=London&limit=2",
  "/api/v1/reports/regions",
  "/api/v1/reports/trends?interval=monthly&start=2024-01-01&end=2024-12-31",
  "/api/v1/data-quality",
  "/api/v1/insights/activity-change?as_of=2024-12-30&window_days=90",
];
try {
  for (const path of paths) {
    console.log(`\nGET ${path}`);
    const response = await fetch(
      `http://127.0.0.1:${process.env.PORT || 8000}${path}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
  }
} catch (error) {
  console.error(
    `Demo failed. Start the server with npm start first. ${error.message}`,
  );
  process.exitCode = 1;
}
