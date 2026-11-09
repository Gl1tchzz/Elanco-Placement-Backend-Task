/** Shared input checks keep API filters and imported dates consistent. */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.status = 422; // A readable request with invalid values.
  }
}

/** Reject impossible dates such as 2024-02-30 rather than letting JS roll them forward. */
export function dateOnly(value, name = "date") {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000")
  ) {
    throw new InputError(`${name} must be a real date in YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new InputError(`${name} must be a real date in YYYY-MM-DD format`);
  }
  return value;
}

/** Missing optional text becomes null; required text must contain something useful. */
export function cleanText(value, required = false) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && !value.trim())
  ) {
    if (required) throw new InputError("missing_required_field");
    return null;
  }
  if (typeof value !== "string" || value.length > 200)
    throw new InputError("invalid_text_field");
  return value.trim().replace(/\s+/g, " ");
}

/** Parse whole-number query values, rejecting arrays, decimals and out-of-range input. */
export function integer(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value))
    throw new InputError(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new InputError(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

/** SQL syntax comes from our code; user values are passed separately as ? parameters. */
export function filters(query) {
  const clauses = [];
  const params = [];
  const start =
    query.start === undefined ? null : dateOnly(query.start, "start");
  const end = query.end === undefined ? null : dateOnly(query.end, "end");
  if (start && end && start > end)
    throw new InputError("start must be on or before end");
  if (start) {
    clauses.push("date >= ?");
    params.push(`${start}T00:00:00Z`);
  }
  if (end) {
    clauses.push("date <= ?");
    params.push(`${end}T23:59:59Z`);
  }
  for (const field of ["location", "region"]) {
    if (query[field] !== undefined) {
      clauses.push(`${field} = ? COLLATE NOCASE`);
      params.push(cleanText(query[field], true));
    }
  }
  return {
    where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
