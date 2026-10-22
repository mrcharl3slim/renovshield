# RenovShield

Demo app for **Minimum Lovable Persons (Group 6)**. RenovShield helps first-time HDB homeowners:

- **Before signing:** compare up to three quotations, check contractors and contract terms, see budget trade-offs and questions to ask.
- **During works:** pay each milestone only after ticking off the work, and keep agreements, changes and payments in one record.
- **At handover:** log defects and hold the final payment until each one is checked.

There are no accounts. Each project has a private link (`/p/<id>`). Anyone with the link can view and edit it, so the link is the only credential: the server sends `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` to keep it out of third-party referrers and shared caches.

Because the link is the only way back in, two things guard against losing it:

- **This device.** Projects you open are remembered in `localStorage` and offered
  on the home page and in the start dialog. Costs nothing, needs no email.
- **Recovery email.** You can attach an address to a project; we mail you the
  link and, later, `Lost your link?` mails you everything saved under that
  address. The recovery link lasts 30 minutes. The address is optional and is
  only asked for after the review, so nothing blocks a first run.

Recovery requests answer identically whether or not the address is known, so the
endpoint cannot be used to discover who has projects here, and are rate limited
per IP (10/hour) and per address (5/hour) so the mailer cannot be pointed at a
third party.

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

### Sending recovery email

Set `GMAIL_USER` and `GMAIL_APP_PASSWORD` (a Google
[App Password](https://myaccount.google.com/apppasswords), not your account
password; the account needs 2-Step Verification turned on). Leave them unset and
everything still works — the server prints recovery links to its log instead of
emailing them, which is fine for local development.

## API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/projects` | Create a project from `{ data }`. Returns `{ id, rev }` |
| `GET` | `/api/projects/:id` | Load a project. Returns `{ data, rev, updatedAt }` |
| `PUT` | `/api/projects/:id` | Save a project from `{ data, rev }`. Returns `{ rev, updatedAt }` |
| `POST` | `/api/projects/:id` | Same as `PUT`; exists because `navigator.sendBeacon` can only POST |
| `PUT` | `/api/projects/:id/email` | Attach or clear (`{ email: null }`) the recovery address. Mails the link |
| `POST` | `/api/recover` | Ask for your projects from `{ email }`. Always answers `{ ok: true }` |
| `GET` | `/api/recover/:token` | Redeem a recovery link. Valid 30 minutes, reusable within it |
| `GET` | `/healthz` | Health check |

`rev` is a revision counter. Send the one you last saw and the save only lands if
nothing else has saved since; otherwise you get `409` with the current
`{ data, rev }` so you can reconcile. Omit `rev` and the save always wins, which
is how the page saves on unload. Project data is validated on write — numbers
must be numbers, and `cat`, `sev`, `status` and `type` must match their known
values — because the browser renders these straight into the page.

## Notes

The pilot figures on the home page are illustrative targets, not real results. RenovShield gives independent guidance, not legal advice.
