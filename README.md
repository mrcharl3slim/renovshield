# RenovShield

Demo app for **Minimum Lovable Persons (Group 6)**. RenovShield helps first-time HDB homeowners:

- **Before signing:** compare up to three quotations, check contractors and contract terms, see budget trade-offs and questions to ask.
- **During works:** pay each milestone only after ticking off the work, and keep agreements, changes and payments in one record.
- **At handover:** log defects and hold the final payment until each one is checked.

There are no accounts. Each project has a private link (`/p/<id>`). Anyone with the link can view and edit it, so the link is the only credential: the server sends `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` to keep it out of third-party referrers and shared caches.

## Run locally

Needs Node 20+ and a Postgres database.

```bash
npm install
DATABASE_URL=postgresql://user:pass@localhost:5432/renovshield npm start
```

Open http://localhost:3000. The table is created on first start.

## Deploy to Render

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and pick this repo. Render reads `render.yaml` and creates the web service and the Postgres database.
3. Click **Apply**. When the deploy finishes, open the service URL.

Notes on Render's free plan:
- The web service sleeps after a period of inactivity, so the first visit can take up to a minute.
- Free Postgres databases expire after a limited time. Check Render's current free-tier terms, and upgrade the database before a demo you rely on.

If you connect with an external database URL, set `PGSSL=true`.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects` | Create a project from `{ data }`. Returns `{ id, rev }` |
| `GET` | `/api/projects/:id` | Load a project. Returns `{ data, rev, updatedAt }` |
| `PUT` | `/api/projects/:id` | Save a project from `{ data, rev }`. Returns `{ rev, updatedAt }` |
| `POST` | `/api/projects/:id` | Same as `PUT`; exists because `navigator.sendBeacon` can only POST |
| `GET` | `/healthz` | Health check |

`rev` is a revision counter. Send the one you last saw and the save only lands if
nothing else has saved since; otherwise you get `409` with the current
`{ data, rev }` so you can reconcile. Omit `rev` and the save always wins, which
is how the page saves on unload. Project data is validated on write — numbers
must be numbers, and `cat`, `sev`, `status` and `type` must match their known
values — because the browser renders these straight into the page.

## Notes

The pilot figures on the home page are illustrative targets, not real results. RenovShield gives independent guidance, not legal advice.
