# Moneta Email Sync

Connect a Gmail inbox to your app. A small Cloudflare Worker reads bank /
payment emails, uses Cloudflare Workers AI to pull out the amount, merchant
and date, and then either **imports the transaction automatically** or puts
it in a **review queue** — depending on how confident the AI is.

It was built for Moneta (React + Firebase),
and this folder is that feature extracted so you can drop it into your own
app.

**This copy is sanitized:** no API keys, service accounts, project IDs,
deployed URLs, or personal emails are included, and debug logging that would
print email subjects/senders/bodies has been removed. You supply your own
credentials (see below) — nothing here works until you do.

---

## What's in the folder

```
Moneta-Email-Sync/
├── README.md                    ← this guide
├── firestore.rules.example      ← recommended security rules
├── worker/                      ← the backend (deploy to Cloudflare Workers)
│   ├── wrangler.toml            ← non-secret config (edit ALLOWED_ORIGINS)
│   ├── .dev.vars.example        ← template for local secrets
│   └── src/                     ← Worker source (Hono + hand-rolled IMAP)
└── frontend/                    ← React pieces to copy into your app
    ├── .env.example             ← VITE_EMAIL_WORKER_URL
    ├── lib/email-connection.ts  ← typed client for every worker endpoint
    └── components/
        ├── email-connection-card.tsx   ← the full Settings UI
        ├── sync-email-button.tsx       ← "Sync now" button
        ├── email-review-list.tsx       ← minimal review queue
        ├── string-list-editor.tsx      ← chip input (used by the card)
        └── empty-state.tsx             ← tiny helper (used by the card)
```

## How it works

```
Your app (browser)
   │  Authorization: Bearer <Firebase ID token>
   ▼
Cloudflare Worker  ──verifies the token itself (Google's public certs)
   ├─► Gmail over IMAP (imap.gmail.com:993) using the user's App Password
   ├─► Workers AI (llama-3.1-8b-instruct-fast) — extract amount/merchant/date
   └─► Firestore REST API (service account) — read accounts/categories,
       write transactions + review items + sync state
```

A sync pass: search Gmail (by folder, sender keywords, subject keywords, since
the last sync) → skip anything already processed → read the body → ask the AI →
gate on confidence:

| AI confidence | Result |
|---|---|
| ≥ `CONFIDENCE_AUTO_IMPORT` (0.90) | Transaction created automatically, account balance updated |
| ≥ `CONFIDENCE_REVIEW` (0.70) | Placed in the review queue for the user to approve/reject |
| below that (or "not a transaction") | Ignored (visible in "Scanned emails", can be re-checked) |

A cron trigger wakes the Worker every 5 minutes and runs whichever users'
chosen schedules (manual / 5 min / … / daily / custom) are due. Each sync
scans at most 50 messages.

## Requirements

- A **Firebase project** with Authentication + Firestore (the Worker verifies
  Firebase ID tokens and stores data in Firestore).
- A **Cloudflare account** (free plan works; Workers AI is on by default).
- Node 18+.
- Each end user needs a **Google App Password** for their Gmail (they create
  it themselves — see "For your users").

> No Google Cloud project or OAuth consent screen is needed. Gmail access is
> IMAP + App Password, a deliberate stopgap for OAuth (see "Limitations").

## Data your app must already have

The Worker reads/writes these under `users/{uid}/...` in Firestore. If your
app uses different names or shapes, edit `worker/src/firestore.ts` and
`worker/src/sync-core.ts`.

| Collection | Used for | Fields the worker relies on |
|---|---|---|
| `accounts` | Matching an email to an account, balance updates | `name`, `current_balance` |
| `categories` | Auto-categorizing by merchant | `name`, `kind` (`"income"` \| `"expense"`) |
| `transactions` | Where imports are written | see below |

A created transaction looks like:

```
account_id, to_account_id (null), category_id, type
("income"|"expense"|"reimbursement"|"refund"|"transfer"), amount (positive
number), occurred_on ("YYYY-MM-DD"), description, merchant, notes,
receipt_url (null), created_at (ISO), email_message_id
```

Balance rule: `expense` subtracts, `transfer` is 0, everything else adds.

The Worker creates and owns these itself: `email_connections/gmail`,
`processed_emails`, `review_transactions`.

## Setup

### 1. Firebase service account
Firebase Console → Project settings → Service accounts → **Generate new
private key**. Keep the JSON private — never commit it or put it in frontend
code. You'll paste it as a single line into a Worker secret.

### 2. Configure and run the Worker locally
```sh
cd worker
npm install
cp .dev.vars.example .dev.vars      # fill in the three values below
npm run dev                         # http://localhost:8787
```

Secrets (`.dev.vars` locally, `wrangler secret put` in production):

| Name | Value |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Service account JSON, minified to one line |
| `FIREBASE_PROJECT_ID` | Your Firebase project ID (must match the frontend's) |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32` — encrypts stored app passwords. **Don't lose or rotate it** without expecting users to reconnect |

Non-secret config lives in `wrangler.toml` → `[vars]`:
`ALLOWED_ORIGINS` (comma-separated origins allowed to call the Worker — set
this to your real app origin), `CONFIDENCE_AUTO_IMPORT`, `CONFIDENCE_REVIEW`,
`AI_MODEL`.

### 3. Deploy the Worker
```sh
cd worker
npx wrangler login
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler deploy
```
Wrangler prints the URL (`https://email-sync-worker.<you>.workers.dev`). Then
update `ALLOWED_ORIGINS` to include your deployed app's origin and deploy
again.

### 4. Wire in the frontend
1. Copy `frontend/lib/email-connection.ts` and the files in
   `frontend/components/` into your app. Adjust import paths if you don't use
   the `@/` alias.
2. Set `VITE_EMAIL_WORKER_URL` (see `frontend/.env.example`) to your Worker
   URL and rebuild.
3. The frontend assumes: `import { auth } from "@/services/firebase"` (a
   Firebase Auth instance), TanStack Query, `sonner` toasts, `lucide-react`,
   and shadcn/ui components (`button, card, badge, input, label, select,
   dialog, alert-dialog, skeleton`). Swap these for your own if you differ.
4. Render `<EmailConnectionCard />` on a settings page, `<SyncEmailButton />`
   wherever you want a sync button, and `<EmailReviewList />` on a review
   page. `email-connection-card.tsx` links to `/needs-review` — change that
   href to wherever you mount the review list.
5. `EmailReviewList` invalidates its own query keys after approving; add your
   app's transactions/accounts query keys there so lists refresh.

### 5. Firestore rules
See `firestore.rules.example`. The Worker uses a service account and bypasses
rules; rules only limit what browsers can do. Recommended: users can only
touch their own `users/{uid}/...` data, and the browser never reads
`email_connections` (which holds the encrypted app password).

## For your users: creating a Gmail App Password
1. Turn on 2-Step Verification on the Google account.
2. Go to <https://myaccount.google.com/apppasswords>, create a password
   (name it anything), copy the 16 characters.
3. Paste the Gmail address and that password into the connect form.
Revoke it any time from the same page, or use Disconnect in the app.

## API reference (all require `Authorization: Bearer <Firebase ID token>`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/email/connect` | `{ email, appPassword }` — verify via one IMAP login, store encrypted |
| GET | `/email/status` | Connection + last-sync summary |
| POST | `/email/sync` | Run one sync pass |
| POST | `/email/disconnect` | Delete the stored connection |
| POST | `/email/schedule` | `{ frequency, customMinutes? }` |
| POST | `/email/search-settings` | `{ folder, senders[], keywords[] }` |
| GET | `/email/scanned` | Recently scanned emails and their outcomes |
| POST | `/email/reprocess` | `{ messageId }` — re-classify one email |
| GET | `/email/review` | Pending review items |
| POST | `/email/review/:id/approve` | Approve (optional field overrides in body) |
| POST | `/email/review/:id/reject` | Discard |

## Security notes
- Secrets exist only as Worker secrets. The browser sees the Worker URL, its
  own ID token, and — only during connect — the app password the user types.
- App passwords are AES-GCM encrypted at rest with `TOKEN_ENCRYPTION_KEY` and
  never logged. Full email bodies are processed in memory and not stored.
- CORS is restricted to `ALLOWED_ORIGINS`; every endpoint verifies the
  Firebase ID token. Keep `ALLOWED_ORIGINS` tight (no `*`).
- Anyone who can deploy the Worker can read users' decrypted app passwords
  (they hold the key). Treat the Cloudflare account and secrets accordingly.
- Before going live, rotate anything you pasted while testing.

## Tuning & troubleshooting
- **Nothing imports:** check the sender/keyword lists in the connection card —
  a sync only considers emails matching them. Use "Scanned emails" to see what
  was looked at, and "Recheck" to re-run one.
- **Everything "not a transaction":** make sure `AI_MODEL` is a currently
  supported Workers AI model. Deprecated models fail; the Worker throws on AI
  errors rather than silently ignoring.
- **Live logs:** `npx wrangler tail`. (Verbose logging was removed from this
  copy so email contents aren't printed; add `console.log`s locally if you
  need them, and remove them again.)
- **Amounts/categories wrong:** raise `CONFIDENCE_AUTO_IMPORT` so more items
  go to review; extend `KEYWORD_HINTS` in `worker/src/categorize.ts`; tweak
  `SYSTEM_PROMPT` in `worker/src/ai.ts`.

## Limitations
- Gmail only (IMAP + App Password). OAuth would need a Google Cloud OAuth
  client and consent screen; everything downstream of "we can read the mail"
  stays the same.
- Hand-rolled IMAP client (no IDLE, no retry) built on `cloudflare:sockets`.
- Max 50 emails per sync; Cloudflare subrequest/rate limits apply.
- LLM output can be wrong — that's what confidence thresholds and the review
  queue are for.
