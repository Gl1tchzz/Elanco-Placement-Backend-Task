# Tick Atlas UK

**Nafiul Alam — Elanco IT placement backend task**

A **Node.js and Express backend** that downloads Elanco tick sightings, saves them in SQLite, and answers questions such as “Which sightings were in London?” and “How many were reported each month?”

## Start here

Open a terminal in this project folder:

```bash
npm ci
npm run refresh
npm start
```

Open **http://127.0.0.1:8000/docs/**. Keep the terminal open; press **Ctrl+C** to stop the server.

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm start`       | Starts the server on your computer                        |
| `npm run refresh` | Downloads, checks and saves a new snapshot                |
| `npm test`        | Runs automatic tests against separate temporary databases |
| `npm run demo`    | Prints example responses; start the server first          |
| `npm run check`   | Checks JavaScript syntax and formatting                   |
| `npm run format`  | Formats the source code consistently                      |

Refreshing is manual. Starting the server does not download data.

## Project Structure

```text
app/
  main.js          Receives browser requests and returns answers
  import-data.js   Downloads and validates sightings
  database.js      Opens the database and creates its tables
  validation.js    Shared checks for dates, numbers and text
  openapi.js       Describes the endpoints for the interactive docs page
  demo.js          Runs a short tour of example requests
tests/
  backend.test.js  Automatic checks of behaviour and failures
  fixtures/       A small synthetic dataset for offline practice
data/             The database saved on your computer
package.json      Project details, npm commands and direct dependencies
package-lock.json Exact dependency versions for reproducible installation
README.md         This beginner's guide
```

`node_modules/` contains installed libraries and the local Node runtime. **You do not need to read or edit it.** `.gitignore` keeps it out of GitHub. `.github/workflows/test.yml` runs checks on GitHub; `.nvmrc` records the Node version; `data/.gitkeep` preserves the empty data folder in Git.

## How it works

```text
REFRESHING DATA
Elanco API → import-data.js checks records → SQLite database

ASKING A QUESTION
Browser → main.js validates your request → database query → JSON answer
```

**Node.js** runs JavaScript outside the browser. **Express** matches incoming requests to functions. **SQLite** stores tables in one file. An **API** lets programs request information from each other, and an **endpoint** is one address for a specific question. **JSON** is the labelled text format used for answers.

For a London search:

1. Your browser requests `/api/v1/sightings?location=London`.
2. Express runs the matching function in `main.js`.
3. `validation.js` checks your filters. Values are passed separately from SQL instructions.
4. SQLite finds matching rows in `data/ticks.sqlite3`.
5. Express sends the rows back as JSON. Elanco is not contacted for this search.

When you refresh, the importer streams records into a temporary staging table. It counts duplicates and missing fields, then publishes the new dataset in one transaction—an all-or-nothing save. If downloading or validation fails, the old data remains available.

## Try it yourself

1. Open `/docs/`, expand **GET /api/v1/sightings**, and click **Try it out**.
2. Enter `London` as `location` and `5` as `limit`.
3. Click **Execute** and inspect the response.
4. Add `start=2024-01-01` and `end=2024-12-31` to filter that year.

`total` counts every match; `items` contains only the requested page. `limit` controls page size and `offset` skips that many results. Dates include both boundary days. City and region names are exact matches ignoring capitals and extra whitespace.

| Endpoint                           | What it answers                                           |
| ---------------------------------- | --------------------------------------------------------- |
| `/health`                          | Is the service responding, and is data loaded?            |
| `/api/v1/sightings`                | Which sightings match these date/location/region filters? |
| `/api/v1/sightings/{sighting_id}`  | What does this particular record contain?                 |
| `/api/v1/reports/regions`          | How many reports are in each region?                      |
| `/api/v1/reports/trends`           | How many reports are in each week or month?               |
| `/api/v1/data-quality`             | When was data imported, and what problems were found?     |
| `/api/v1/insights/activity-change` | How do counts compare across two equal windows?           |

For activity change, use `as_of=2024-12-30` and `window_days=90`. The source observations inspected during development span 2012–2024. A recent import does not make those observations current.

The extension returns counts, percentage change and an explanation. Fewer than five previous-window reports is labelled an insufficient baseline; a zero baseline produces a null percentage. This is descriptive analytics, **not a trained AI model or disease-risk forecast**.
