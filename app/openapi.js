/** This description powers Swagger's interactive /docs page. It contains no database logic. */
const query = (name, schema, description, required = false) => ({
  name,
  in: "query",
  required,
  description,
  schema,
});
const text = { type: "string", minLength: 1, maxLength: 200 };
const date = { type: "string", format: "date" };
const filters = [
  query("start", date, "First included date (UTC)."),
  query("end", date, "Last included date (UTC)."),
  query("location", text, "Exact city name, ignoring capitals.", false),
  query("region", text, "Exact region name, ignoring capitals.", false),
];
const integer = (minimum, maximum, defaultValue) => ({
  type: "integer",
  minimum,
  maximum,
  default: defaultValue,
});
const error = {
  description: "Request failed",
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["detail"],
        properties: { detail: { type: "string" } },
      },
    },
  },
};

/** One helper keeps status codes and response documentation consistent across routes. */
function get(summary, tag, parameters = [], schema = { type: "object" }) {
  return {
    get: {
      summary,
      tags: [tag],
      parameters,
      responses: {
        200: {
          description: "Successful response",
          content: { "application/json": { schema } },
        },
        422: error,
        500: error,
      },
    },
  };
}
const sighting = {
  type: "object",
  required: ["id", "date", "location", "region", "species", "latin_name"],
  properties: {
    id: text,
    date: { type: "string", format: "date-time" },
    location: text,
    region: text,
    species: { type: "string", nullable: true },
    latin_name: { type: "string", nullable: true },
  },
};
export const specification = {
  openapi: "3.0.3",
  info: {
    title: "Tick Atlas UK — Node.js",
    version: "2.0.0",
    description:
      "Nafiul Alam’s Elanco placement backend. Educational sighting reports, not current disease risk. Refresh with npm run refresh. Date filters are inclusive and use UTC.",
  },
  paths: {
    "/health": get("Check the service and data availability", "Operations"),
    "/api/v1/sightings": get(
      "Search and paginate sightings",
      "Sightings",
      [
        ...filters,
        query("limit", integer(1, 200, 50), "Maximum records in this page."),
        query("offset", integer(0, 1000000, 0), "Matching records to skip."),
      ],
      {
        type: "object",
        properties: {
          total: { type: "integer" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          items: { type: "array", items: sighting },
        },
      },
    ),
    "/api/v1/sightings/{sighting_id}": get(
      "Find one sighting",
      "Sightings",
      [
        {
          name: "sighting_id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      sighting,
    ),
    "/api/v1/reports/regions": get(
      "Count sightings by region",
      "Reports",
      filters,
    ),
    "/api/v1/reports/trends": get(
      "Count sightings by week or month",
      "Reports",
      [
        ...filters,
        query(
          "interval",
          { type: "string", enum: ["weekly", "monthly"], default: "monthly" },
          "Weeks start on Monday; empty periods are omitted.",
        ),
      ],
    ),
    "/api/v1/data-quality": get(
      "Inspect data quality and freshness",
      "Operations",
    ),
    "/api/v1/insights/activity-change": get(
      "Compare two adjacent time windows",
      "Explainable extension",
      [
        query(
          "as_of",
          { ...date, example: "2024-12-30" },
          "Final included date; choose a date within historical coverage.",
          true,
        ),
        query(
          "window_days",
          integer(7, 365, 90),
          "Length of each comparison window.",
        ),
      ],
    ),
  },
};
specification.paths["/api/v1/sightings/{sighting_id}"].get.responses[404] =
  error;
