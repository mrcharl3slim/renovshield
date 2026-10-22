// RenovShield demo server: serves the web app and stores each project as JSON in Postgres.
// Each project is reached by a private, unguessable link: /p/<id>.
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const nodemailer = require("nodemailer");
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
  // Optional recovery address. The project link is still the key; this is the
  // safety net for someone who loses it.
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_email TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS projects_owner_email_idx ON projects (lower(owner_email))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recovery_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`);
  await pool.query(`DELETE FROM recovery_tokens WHERE expires_at < now()`);
}

/* ---------------- email ---------------- */
// Gmail SMTP: works with an app password and no verified domain, which suits a
// demo. Unconfigured, the link is logged instead so the flow still works locally.
// Somebody is waiting on a page while this runs, so every stage is bounded.
// Hosts commonly throttle or block outbound SMTP, and the failure mode without
// these is a request that hangs for two minutes.
const MAIL_TIMEOUT_MS = Number(process.env.MAIL_TIMEOUT_MS || 8000);
const mailer = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
      connectionTimeout: MAIL_TIMEOUT_MS,
      greetingTimeout: MAIL_TIMEOUT_MS,
      socketTimeout: MAIL_TIMEOUT_MS,
    })
  : null;
if (!mailer) console.warn("GMAIL_USER / GMAIL_APP_PASSWORD not set - recovery links will be logged, not emailed.");

function withTimeout(promise, ms, label) {
  promise.catch(() => {});   // a late rejection must not surface as unhandled
  let timer;
  const bell = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, bell]).finally(() => clearTimeout(timer));
}

// Returns whether the message actually went out. Never throws, and never takes
// longer than the budget above - the caller saves the address either way.
async function sendMail(to, subject, body) {
  if (!mailer) {
    console.log(`[email not configured] would send to ${to}\n--- ${subject} ---\n${body}\n---`);
    return false;
  }
  try {
    await withTimeout(
      mailer.sendMail({ from: `RenovShield <${process.env.GMAIL_USER}>`, to, subject, text: body }),
      MAIL_TIMEOUT_MS + 2000, "SMTP send");
    return true;
  } catch (e) {
    console.error(`Could not email ${to}:`, e.message);
    return false;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const validEmail = e => typeof e === "string" && e.length <= 254 && EMAIL_RE.test(e);
// j••••@gmail.com - enough to recognise your own address, not enough to harvest.
function maskEmail(e) {
  if (!e) return null;
  const [user, domain] = e.split("@");
  return user.slice(0, 1) + "•".repeat(Math.max(3, Math.min(8, user.length - 1))) + "@" + domain;
}
const origin = req => `${req.protocol}://${req.get("host")}`;

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

// Simple sliding-window limits (protect the free database, and keep the mailer
// from being used to spam a third party).
const HOUR = 60 * 60 * 1000;
const buckets = new Map();
function rateLimit(name, max, windowMs, message, keyOf = req => req.ip) {
  const hits = new Map();
  buckets.set(name, [hits, windowMs]);
  return (req, res, next) => {
    const key = keyOf(req);
    if (key === undefined || key === null) return next();
    const now = Date.now();
    const live = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (live.length >= max) return res.status(429).json({ error: message });
    live.push(now); hits.set(key, live); next();
  };
}
const createLimit = rateLimit("create", 30, HOUR, "Too many new projects. Try again later.");
// Two limits on recovery: one stops an IP hammering the endpoint, the other
// stops anyone using it to mail-bomb a single address.
const recoverIpLimit = rateLimit("recover-ip", 10, HOUR, "Too many recovery requests. Try again later.");
const recoverEmailLimit = rateLimit("recover-email", 5, HOUR, "Too many recovery requests for that address. Try again later.",
  req => (req.body && typeof req.body.email === "string") ? req.body.email.trim().toLowerCase() : null);

// A key that is used once and never again would otherwise live forever.
setInterval(() => {
  const now = Date.now();
  for (const [hits, windowMs] of buckets.values()) {
    for (const [key, times] of hits) {
      const live = times.filter(t => now - t < windowMs);
      if (live.length) hits.set(key, live); else hits.delete(key);
    }
  }
  pool.query("DELETE FROM recovery_tokens WHERE expires_at < now()").catch(e => console.error(e));
}, HOUR).unref();

app.get("/healthz", async (_req, res) => {
  // mail reports only whether credentials are present - never what they are.
  // Without it there is no way to tell an unconfigured mailer from a blocked
  // SMTP port, since both just mean "the email didn't go".
  const mail = mailer ? "configured" : "not configured";
  try { await pool.query("SELECT 1"); res.json({ ok: true, mail }); }
  catch (e) { res.status(500).json({ ok: false, mail }); }
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
  const r = await pool.query("SELECT data, rev, updated_at, owner_email FROM projects WHERE id = $1", [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found." });
  res.json({
    data: r.rows[0].data, rev: r.rows[0].rev, updatedAt: r.rows[0].updated_at,
    // Masked: anyone holding the link can read this, and it is someone's address.
    recoveryEmail: maskEmail(r.rows[0].owner_email),
  });
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

// TEMPORARY diagnostic: is outbound SMTP blocked, or is all egress blocked?
// Hardcoded targets only - no user input reaches the socket. Removed once answered.
app.get("/api/_egress", h(async (_req, res) => {
  const net = require("net");
  const probe = (host, port) => new Promise(resolve => {
    const t0 = Date.now();
    const sock = net.createConnection({ host, port });
    const done = r => { sock.destroy(); resolve(`${r} in ${Date.now() - t0}ms`); };
    sock.setTimeout(6000);
    sock.on("connect", () => done("open"));
    sock.on("timeout", () => done("TIMEOUT"));
    sock.on("error", e => done("error: " + e.code));
  });
  res.json({
    "smtp.gmail.com:587": await probe("smtp.gmail.com", 587),
    "smtp.gmail.com:465": await probe("smtp.gmail.com", 465),
    "api.brevo.com:443": await probe("api.brevo.com", 443),
    "example.com:80": await probe("example.com", 80),
  });
}));

/* ---------------- recovery ---------------- */

// Attach or clear the address this project can be recovered to.
app.put("/api/projects/:id/email", h(async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: "Not found." });
  const raw = req.body && req.body.email;
  const email = raw === null || raw === "" ? null : (typeof raw === "string" ? raw.trim() : raw);
  if (email !== null && !validEmail(email)) return res.status(400).json({ error: "That doesn't look like an email address." });
  const r = await pool.query("UPDATE projects SET owner_email = $2 WHERE id = $1 RETURNING owner_email", [req.params.id, email]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found." });

  // emailed reflects what actually happened: sendMail returns false when no
  // mailer is configured, and the UI must not claim an inbox has something in it.
  let emailed = false;
  if (email) {
    const link = `${origin(req)}/p/${req.params.id}`;
    emailed = await sendMail(email, "Your RenovShield project link",
      `Here is the link to your RenovShield project. Keep this email — the link is the only way back in.\n\n${link}\n\n` +
      `Anyone with the link can view and edit the project, so share it only with people you trust.\n\n` +
      `Lost it later? Go to ${origin(req)} and choose "Lost your link?".`);
  }
  res.json({ recoveryEmail: maskEmail(email), emailed });
}));

// Ask for your projects. Always answers the same way, so this cannot be used to
// find out whether an address has projects here.
app.post("/api/recover", recoverIpLimit, recoverEmailLimit, h(async (req, res) => {
  const email = req.body && typeof req.body.email === "string" ? req.body.email.trim() : "";
  if (!validEmail(email)) return res.status(400).json({ error: "That doesn't look like an email address." });

  const r = await pool.query("SELECT 1 FROM projects WHERE lower(owner_email) = lower($1) LIMIT 1", [email]);
  if (r.rowCount) {
    const token = crypto.randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO recovery_tokens (token, email, expires_at) VALUES ($1, $2, now() + interval '30 minutes')", [token, email]);
    await sendMail(email, "Your RenovShield projects",
      `Here is a link to the RenovShield projects saved under this address. It works for 30 minutes.\n\n` +
      `${origin(req)}/recover/${token}\n\n` +
      `If you didn't ask for this, you can ignore this email — nothing has changed.`);
  }
  res.json({ ok: true });
}));

// Redeem a recovery link. Valid for 30 minutes, reusable within that window so a
// refresh doesn't strand anyone.
app.get("/api/recover/:token", h(async (req, res) => {
  const t = await pool.query("SELECT email FROM recovery_tokens WHERE token = $1 AND expires_at > now()", [req.params.token]);
  if (!t.rowCount) return res.status(404).json({ error: "That link has expired. Ask for a new one." });
  const email = t.rows[0].email;
  const r = await pool.query(
    `SELECT id, data->>'owner' AS owner, updated_at FROM projects
     WHERE lower(owner_email) = lower($1) ORDER BY updated_at DESC LIMIT 50`, [email]);
  res.json({
    email: maskEmail(email),
    projects: r.rows.map(p => ({ id: p.id, owner: p.owner || "", updatedAt: p.updated_at })),
  });
}));

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

// Front end: one page that shows the site at "/" and the app at "/p/<id>".
const indexFile = path.join(__dirname, "public", "index.html");
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get(["/", "/p/:id", "/recover/:token"], (_req, res) => res.sendFile(indexFile));
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
