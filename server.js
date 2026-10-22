// RenovShield demo server: serves the web app and stores each project as JSON in Postgres.
// Each project is reached by a private, unguessable link: /p/<id>.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Point it at a Postgres database.");
  process.exit(1);
}

// Render's internal database URL needs no SSL; set PGSSL=true when using an external URL.
// rejectUnauthorized is off deliberately: hosted Postgres commonly presents a
// self-signed cert. Point PGSSLROOTCERT at the provider's CA to verify properly.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id         TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      rev        INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  // rev counts saves. A timestamp can't do this job: Postgres keeps microseconds
  // and a JSON round-trip through JS Date truncates to milliseconds, so the
  // value sent back would never match.
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS rev INTEGER NOT NULL DEFAULT 1`);
}

const app = express();
// Render terminates TLS at its own proxy; without this every request looks like
// it comes from that proxy and the per-IP limit below becomes one global bucket.
app.set("trust proxy", 1);
app.disable("x-powered-by");

// A project link is the only credential there is, so keep it out of Referer
// headers sent to the font CDN, and out of shared caches.
app.use((_req, res, next) => {
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "));
  next();
});

app.use(express.json({ limit: "256kb" }));

// Project data is per-link private and changes constantly; never let it be cached.
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });

// Pass async errors to the error handler (Express 4 does not do this itself).
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ID_RE = /^[A-Za-z0-9_-]{16,40}$/;
const newId = () => crypto.randomBytes(16).toString("base64url");

// Shape AND type checks. The browser puts these values straight into the page,
// so a stored string where a number belongs is an injection vector: reject it here
// and escape it there.
const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
const num = v => typeof v === "number" && Number.isFinite(v);
const str = (v, max) => typeof v === "string" && v.length <= max;
const opt = (v, ok) => v === undefined || ok(v);
const arr = (v, max, ok) => Array.isArray(v) && v.length <= max && v.every(ok);

const CATS = ["essential", "priority", "optional"];
const SEVS = ["Minor", "Major"];
const DEFECT_STATUS = ["Open", "Fixed", "Checked"];
const RECORD_TYPES = ["Agreement", "Change order", "Photo note", "Payment", "Issue"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const validFirm = f => obj(f) &&
  str(f.name, 120) && num(f.depositPct) && num(f.cancelFee) &&
  ["drc", "casetrust", "completion", "escalation"].every(k => typeof f[k] === "boolean");

// Each item carries one price per firm, so the two arrays must line up.
const validItem = nFirms => it => obj(it) &&
  str(it.name, 200) && num(it.lo) && num(it.hi) && CATS.includes(it.cat) &&
  Array.isArray(it.vals) && it.vals.length === nFirms &&
  it.vals.every(v => v === null || num(v));

const validMilestone = m => obj(m) &&
  str(m.name, 200) && num(m.pct) &&
  arr(m.checks, 20, c => str(c, 300)) &&
  Array.isArray(m.done) && m.done.length === m.checks.length &&
  m.done.every(v => typeof v === "boolean") &&
  typeof m.paid === "boolean" &&
  opt(m.final, v => typeof v === "boolean") &&
  opt(m.paidAmt, num);

const validRecord = r => obj(r) &&
  str(r.date, 10) && DATE_RE.test(r.date) && RECORD_TYPES.includes(r.type) &&
  str(r.title, 300) && str(r.note, 4000) && num(r.amt);

const validDefect = d => obj(d) &&
  str(d.room, 100) && str(d.desc, 500) &&
  SEVS.includes(d.sev) && DEFECT_STATUS.includes(d.status);

function validProject(d) {
  return obj(d) &&
    opt(d.owner, v => str(v, 120)) &&
    ["budget", "deposit", "buffer"].every(k => opt(d[k], num)) &&
    opt(d.signed, v => Number.isInteger(v) && v >= 0) &&
    Array.isArray(d.firms) && d.firms.length >= 1 && d.firms.length <= 6 &&
    d.firms.every(validFirm) &&
    arr(d.items, 200, validItem(d.firms.length)) &&
    opt(d.milestones, v => arr(v, 50, validMilestone)) &&
    opt(d.records, v => arr(v, 1000, validRecord)) &&
    opt(d.defects, v => arr(v, 500, validDefect));
}

// Simple per-IP limit on project creation (protects the free database from spam).
const HOUR = 60 * 60 * 1000;
const createHits = new Map();
function createLimit(req, res, next) {
  const now = Date.now(), ip = req.ip;
  const hits = (createHits.get(ip) || []).filter(t => now - t < HOUR);
  if (hits.length >= 30) return res.status(429).json({ error: "Too many new projects. Try again later." });
  hits.push(now); createHits.set(ip, hits); next();
}
// An IP that visits once and never returns would otherwise keep its entry forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of createHits) {
    const live = hits.filter(t => now - t < HOUR);
    if (live.length) createHits.set(ip, live); else createHits.delete(ip);
  }
}, HOUR).unref();

app.get("/healthz", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

app.post("/api/projects", createLimit, h(async (req, res) => {
  const data = req.body && req.body.data;
  if (!validProject(data)) return res.status(400).json({ error: "Invalid project data." });
  const id = newId();
  await pool.query("INSERT INTO projects (id, data) VALUES ($1, $2)", [id, data]);
  res.status(201).json({ id, rev: 1 });
}));

app.get("/api/projects/:id", h(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: "Not found." });
  const r = await pool.query("SELECT data, rev, updated_at FROM projects WHERE id = $1", [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found." });
  res.json({ data: r.rows[0].data, rev: r.rows[0].rev, updatedAt: r.rows[0].updated_at });
}));

// Saving. A caller that sends the rev it last saw only wins if nothing else has
// saved since; otherwise it gets 409 and the current version to reconcile against.
const saveProject = h(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: "Not found." });
  const data = req.body && req.body.data;
  if (!validProject(data)) return res.status(400).json({ error: "Invalid project data." });
  const rev = req.body.rev;
  if (rev !== undefined && rev !== null && !Number.isInteger(rev)) {
    return res.status(400).json({ error: "Invalid rev." });
  }
  const guard = Number.isInteger(rev);
  const r = guard
    ? await pool.query(
        "UPDATE projects SET data = $2, rev = rev + 1, updated_at = now() WHERE id = $1 AND rev = $3 RETURNING rev, updated_at",
        [req.params.id, data, rev])
    : await pool.query(
        "UPDATE projects SET data = $2, rev = rev + 1, updated_at = now() WHERE id = $1 RETURNING rev, updated_at",
        [req.params.id, data]);
  if (!r.rowCount) {
    // Nothing updated: either the project is gone, or someone else saved first.
    const cur = await pool.query("SELECT data, rev, updated_at FROM projects WHERE id = $1", [req.params.id]);
    if (!cur.rowCount) return res.status(404).json({ error: "Not found." });
    return res.status(409).json({
      error: "This project was changed somewhere else.",
      data: cur.rows[0].data, rev: cur.rows[0].rev, updatedAt: cur.rows[0].updated_at,
    });
  }
  res.json({ rev: r.rows[0].rev, updatedAt: r.rows[0].updated_at });
});
app.put("/api/projects/:id", saveProject);
// navigator.sendBeacon, which the page uses on unload, can only issue a POST.
app.post("/api/projects/:id", saveProject);

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Front end: one page that shows the site at "/" and the app at "/p/<id>".
const indexFile = path.join(__dirname, "public", "index.html");
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get(["/", "/p/:id"], (_req, res) => res.sendFile(indexFile));
// Customer journey map. Also reachable at /journey.html via the static handler.
app.get("/journey", (_req, res) => res.sendFile(path.join(__dirname, "public", "journey.html")));
app.use((_req, res) => res.status(404).sendFile(indexFile));

// Last-resort logging.
process.on("unhandledRejection", e => console.error(e));
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "Project is too large." });
  console.error(err);
  res.status(500).json({ error: "Server error." });
});

migrate()
  .then(() => app.listen(PORT, () => console.log(`RenovShield running on port ${PORT}`)))
  .catch(e => { console.error("Database setup failed:", e.message); process.exit(1); });
