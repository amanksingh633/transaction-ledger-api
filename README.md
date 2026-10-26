# Transaction Ledger API

A backend API for a simple transaction ledger: create accounts, post credits and debits, read balances and paginated history, and move money between accounts atomically.

**Stack:** Node.js 18+ · TypeScript · Express 5 · PostgreSQL (Supabase in production) · `pg` · zod · Jest + Supertest

It also includes **Paisa Wallet** (`public/index.html`), a mobile-style frontend served at `/`:
- **Live mode:** it uses the real API automatically when `/health` answers.
- **Demo mode:** otherwise it runs an in-browser copy of the same ledger rules on sample data, with the same validation, error codes and JSON.
- **Developer tab:** shows the last request and response, and lets you point the page at any API URL.

---

## Contents

- [Quick start](#quick-start)
- [Running the tests](#running-the-tests)
- [Project structure](#project-structure)
- [API documentation](#api-documentation)
- [Error handling](#error-handling)
- [How data integrity is guaranteed](#how-data-integrity-is-guaranteed)
- [Assumptions](#assumptions)
- [Deployment](#deployment)

---

## Quick start

**Prerequisites:** Node.js 18+ and a PostgreSQL database (local Postgres 13+ or a free Supabase project).

```bash
git clone https://github.com/amanksingh633/transaction-ledger-api.git
cd transaction-ledger-api
npm install
cp .env.example .env          # then edit DATABASE_URL
```

Create the database if you're using local Postgres:

```bash
createdb ledger               # for the app
createdb ledger_test          # for the tests (it gets wiped)
```

Start the server. It applies the schema on startup; `npm run db:migrate` does the same on its own.

```bash
npm run dev                   # http://localhost:3000
```

Open <http://localhost:3000> for the frontend, or call the API directly:

```bash
curl -X POST localhost:3000/accounts -H 'Content-Type: application/json' -d '{"name":"Aman"}'
```

**Using Supabase:** in your project go to **Connect → Connection string → URI**, paste it into `DATABASE_URL`, and set `DATABASE_SSL=true`. If your network has no IPv6 (Render, many home networks), use the **Session pooler** string.

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/` and run the compiled server |
| `npm run db:migrate` | Apply `db/schema.sql` (safe to re-run) |
| `npm test` | Run the test suite against `TEST_DATABASE_URL` |
| `npm run typecheck` | TypeScript check |

## Running the tests

```bash
npm test
```

There are 73 tests, run against a real Postgres database (`TEST_DATABASE_URL`, default `ledger_test`), so the constraints and row locks under test are the real ones. They cover every rule in the brief, plus:

- **Concurrency:**
  - Two simultaneous ₹80 debits on ₹100: exactly one succeeds and the balance ends at ₹20.
  - 15 simultaneous debits never overdraw.
  - The same `reference_id` sent twice at once is applied only once.
  - 20 opposite-direction transfers run at the same time without deadlocking.
- **Rollback:** a transfer whose credit leg fails leaves both accounts and the transfers table untouched.
- **Database-level guarantees:** direct SQL `UPDATE`/`DELETE` on a transaction is refused, and a negative balance is refused.
- **Ledger invariant:** after each scenario, the stored balance equals `sum(credits) − sum(debits)`.

## Project structure

```
db/schema.sql              Tables, constraints, indexes, immutability triggers
src/
  server.ts                Entry point: migrate, then listen
  app.ts                   Express app: middleware, routes, error handler
  config.ts                Environment variables
  db/pool.ts               Connection pool + withTransaction() helper
  db/migrate.ts            Applies db/schema.sql
  lib/validation.ts        zod schemas; maps validation failures to error codes
  lib/errors.ts            AppError, consistent error responses, DB error mapping
  lib/money.ts             Rupees <-> paise conversion
  routes/                  HTTP layer: parse input, call a service, send the response
  services/                Business rules and SQL (accounts, transactions, transfers)
public/                    One-page frontend (served at / and deployable to Netlify)
tests/                     Jest + Supertest integration tests
```

Routes only parse input and shape responses. Every business rule lives in `services/`, and the database enforces the critical ones a second time.

---

## API documentation

Base URL: `http://localhost:3000` locally.

All request and response bodies are JSON. Amounts are in **rupees** and can have up to 2 decimal places, e.g. `100` or `99.50`. Timestamps are ISO-8601 in UTC.

### Summary

| Method | Path | Description |
|---|---|---|
| `POST` | `/accounts` | Create an account |
| `GET` | `/accounts/{id}/balance` | Get an account's balance |
| `POST` | `/accounts/{id}/transactions` | Add a credit or debit |
| `GET` | `/accounts/{id}/transactions` | Transaction history (filter + pagination, newest first) |
| `POST` | `/transfers` | **Bonus:** atomic transfer between two accounts |
| `GET` | `/accounts/{id}` | Get one account (extra) |
| `GET` | `/accounts` | List accounts, newest first, paginated (extra, used by the UI) |
| `GET` | `/health` | Health check, including the DB connection (extra) |

---

### 1. Create account: `POST /accounts`

**Request**

```json
{ "name": "Aman Singh" }
```

| Field | Rules |
|---|---|
| `name` | Required, a string of 1–200 characters after trimming. |

`id`, `balance` and `created_at` are set by the server. Sending any of them, or any other unknown field, returns `400`.

**Response `201 Created`**

```json
{
  "id": "7161a094-fa59-4b03-8aa8-e9ab5ad2edb5",
  "name": "Aman Singh",
  "balance": 0,
  "created_at": "2026-10-26T11:22:18.943Z"
}
```

**Errors:** `400 INVALID_REQUEST_BODY` (missing or blank name, unknown fields, body not an object) · `400 INVALID_JSON`

---

### 2. Add transaction: `POST /accounts/{id}/transactions`

**Request**

```json
{
  "type": "credit",
  "amount": 100,
  "reference_id": "INV-1001",
  "description": "Opening deposit"
}
```

| Field | Rules |
|---|---|
| `type` | Required: `"credit"` or `"debit"`. |
| `amount` | Required: a JSON number, greater than 0, at most 2 decimal places, and at most 1,000,000,000. |
| `reference_id` | Required: a non-empty string of up to 100 characters, unique **per account**. |
| `description` | Optional: a string of up to 500 characters. |

**What happens**

- A **credit** adds `amount` to the balance.
- A **debit** subtracts it, but only if the balance is at least `amount`. Otherwise it is rejected and nothing changes.
- A repeated `reference_id` on the same account creates nothing and changes nothing. It returns `409`, with the original transaction in `error.details.transaction`.

**Response `201 Created`.** This is the stored transaction plus the account's balance after it:

```json
{
  "id": "a47ce5a4-0a3f-4d7e-8962-61677eb5bae5",
  "account_id": "7161a094-fa59-4b03-8aa8-e9ab5ad2edb5",
  "type": "credit",
  "amount": 100,
  "description": "Opening deposit",
  "reference_id": "INV-1001",
  "transfer_id": null,
  "created_at": "2026-10-26T11:22:19.007Z",
  "account_balance": 100
}
```

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_ACCOUNT_ID` | `{id}` is not a UUID |
| 400 | `INVALID_TRANSACTION_TYPE` | `type` is not `credit`/`debit` |
| 400 | `INVALID_AMOUNT` | `amount` is missing, not a number, ≤ 0, or has more than 2 decimals |
| 400 | `INVALID_REQUEST_BODY` | `reference_id` missing or blank, unknown fields, body not an object |
| 400 | `INVALID_JSON` | Body is not valid JSON |
| 404 | `ACCOUNT_NOT_FOUND` | No account with that id |
| 409 | `DUPLICATE_TRANSACTION` | `reference_id` already used on this account |
| 422 | `INSUFFICIENT_BALANCE` | Debit larger than the current balance |

Example `422`:

```json
{
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Insufficient balance: account has 100, debit needs 150",
    "details": { "account_id": "7161a094-…", "balance": 100, "requested": 150 }
  }
}
```

Transactions are **immutable**. There is no endpoint to edit or delete one. `PUT`, `PATCH` and `DELETE` on `/accounts/{id}/transactions[/{txId}]` return `405 METHOD_NOT_ALLOWED`.

---

### 3. Get balance: `GET /accounts/{id}/balance`

**Response `200 OK`**

```json
{ "account_id": "7161a094-fa59-4b03-8aa8-e9ab5ad2edb5", "balance": 100, "currency": "INR" }
```

**Errors:** `400 INVALID_ACCOUNT_ID` · `404 ACCOUNT_NOT_FOUND`

---

### 4. Transaction history: `GET /accounts/{id}/transactions`

**Query parameters**

| Param | Default | Rules |
|---|---|---|
| `type` | (both) | `credit` or `debit`. Leave it out to get both. |
| `page` | `1` | An integer ≥ 1. |
| `limit` | `10` | An integer from 1 to 100. |

Results are sorted **newest first** by `created_at`. Ties are broken by insertion order.

Example: `GET /accounts/{id}/transactions?type=credit&page=2&limit=2`

**Response `200 OK`**

```json
{
  "data": [
    { "id": "…", "account_id": "…", "type": "credit", "amount": 30, "description": null,
      "reference_id": "c3", "transfer_id": null, "created_at": "2026-10-26T11:22:19.046Z" }
  ],
  "pagination": {
    "current_page": 2,
    "page_size": 2,
    "total_records": 5,
    "total_pages": 3
  }
}
```

A page past the end returns `data: []`, with the correct totals.

**Errors:** `400 INVALID_PAGINATION` (e.g. `page=0`, `page=abc`, `limit=101`, `page=1.5`, `page` given twice) · `400 INVALID_TRANSACTION_TYPE` · `400 INVALID_ACCOUNT_ID` · `404 ACCOUNT_NOT_FOUND`

---

### 5. Bonus: transfer: `POST /transfers`

**Request**

```json
{
  "from_account_id": "7161a094-…",
  "to_account_id": "bfd55be2-…",
  "amount": 30,
  "reference_id": "TRF-001",
  "description": "Rent share"
}
```

| Field | Rules |
|---|---|
| `from_account_id`, `to_account_id` | Required UUIDs of two **different** existing accounts. |
| `amount` | Same rules as for transactions. |
| `reference_id` | Optional. If given, repeating it for the same source account returns `409 DUPLICATE_TRANSFER` and moves no money. If omitted, the server generates one, so that request has no duplicate protection. |
| `description` | Optional. It is used on both legs; it defaults to "Transfer to/from {id}". |

A transfer creates one `transfers` row and **two linked transactions**: a debit on the source and a credit on the destination. Both legs carry `transfer_id`, and both use `reference_id` `transfer:{reference_id}`. All of it is one database transaction.

Example: A has 100 and B has 50. Transferring 30 leaves A with 70 and B with 80.

**Response `201 Created`**

```json
{
  "transfer": { "id": "01b09c72-…", "from_account_id": "7161a094-…", "to_account_id": "bfd55be2-…",
                "amount": 30, "description": "Rent share", "reference_id": "TRF-001", "created_at": "…" },
  "debit_transaction":  { "id": "…", "account_id": "7161a094-…", "type": "debit",  "amount": 30, "transfer_id": "01b09c72-…", "…": "…" },
  "credit_transaction": { "id": "…", "account_id": "bfd55be2-…", "type": "credit", "amount": 30, "transfer_id": "01b09c72-…", "…": "…" },
  "from_account": { "id": "7161a094-…", "balance": 70 },
  "to_account":   { "id": "bfd55be2-…", "balance": 80 }
}
```

**Errors:** `400 INVALID_ACCOUNT_ID` · `400 INVALID_AMOUNT` · `400 SAME_ACCOUNT_TRANSFER` · `400 INVALID_REQUEST_BODY` · `404 ACCOUNT_NOT_FOUND` (`details.account_id` says which account) · `409 DUPLICATE_TRANSFER` · `422 INSUFFICIENT_BALANCE`

---

## Error handling

Every error has the same shape:

```json
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "Human-readable explanation",
    "details": "optional: field errors, the existing duplicate, balances…"
  }
}
```

For validation errors, `details` lists every problem found (`[{ "field": "amount", "message": "amount must be greater than 0" }, …]`). `code` and `message` describe the most relevant one.

| Status | Codes |
|---|---|
| 400 Bad Request | `INVALID_JSON`, `INVALID_REQUEST_BODY`, `INVALID_ACCOUNT_ID`, `INVALID_TRANSACTION_TYPE`, `INVALID_AMOUNT`, `INVALID_PAGINATION`, `SAME_ACCOUNT_TRANSFER` |
| 404 Not Found | `ACCOUNT_NOT_FOUND`, `NOT_FOUND` (unknown route) |
| 405 Method Not Allowed | `METHOD_NOT_ALLOWED` (attempt to edit/delete a transaction) |
| 409 Conflict | `DUPLICATE_TRANSACTION`, `DUPLICATE_TRANSFER` |
| 413 Payload Too Large | `PAYLOAD_TOO_LARGE` (body over 10 KB) |
| 422 Unprocessable Entity | `INSUFFICIENT_BALANCE` |
| 500 Internal Server Error | `INTERNAL_ERROR` (details are logged, never leaked) |

**Why 422 for insufficient balance:** the request is well formed (unlike a `400`), but it can't be applied to the account in its current state.

---

## How data integrity is guaranteed

Every rule is checked in code, which gives a clear error message, and enforced again by the database, which holds even if the code has a bug.

| Rule | In code | In the database (`db/schema.sql`) |
|---|---|---|
| Balance never negative | Debit rejected if `balance < amount` | `CHECK (balance >= 0)` |
| Amount > 0 | zod schema | `CHECK (amount > 0)` |
| Type is credit/debit | zod enum | `CHECK (type IN ('credit','debit'))` |
| `reference_id` unique per account | Looked up before inserting | `UNIQUE (account_id, reference_id)` |
| Transaction belongs to a real account | Account looked up and locked first | `FOREIGN KEY … REFERENCES accounts ON DELETE RESTRICT` |
| Transactions immutable | No update/delete endpoints (405) | Trigger raises an error on any `UPDATE`/`DELETE` |
| No transfer to self | `SAME_ACCOUNT_TRANSFER` | `CHECK (from_account_id <> to_account_id)` |

**Atomicity.** Each write runs inside `withTransaction()` (`BEGIN … COMMIT`, with `ROLLBACK` on any error). The transaction insert and the balance update commit together or not at all. For a transfer, five writes commit together: the transfer row, two transactions and two balance updates. There is a test that forces the credit leg to fail and checks that nothing was saved.

**Race conditions.** Before checking a balance, the service locks the account row with `SELECT … FOR UPDATE`. A second request for the same account waits until the first commits, then sees the new balance. This stops two ₹80 debits on ₹100 from both succeeding. The `CHECK (balance >= 0)` constraint is the backstop. A transfer locks both accounts **in sorted id order**, so A→B and B→A running at the same time can't deadlock.

**Idempotency.** `reference_id` makes retries safe: a client that times out can resend the same request without being charged twice. The duplicate check runs **before** the balance check. So a retried debit returns `409 DUPLICATE_TRANSACTION` (it already happened), not `422` (as if it had failed).

**Balance consistency.** `accounts.balance` is a cached total. Transactions are only ever inserted, and every insert updates the balance in the same transaction. So `balance = Σ credits − Σ debits` always holds, and the tests check it directly in SQL.

**Money.** Amounts are stored as `BIGINT` **paise**, never as floats: `0.1 + 0.2` gives exactly `0.3`.

## Assumptions

1. **Currency is INR.** The API accepts and returns rupees with up to 2 decimals and stores integer paise. The maximum per transaction is ₹1,000,000,000.
2. **IDs are UUIDs** generated by the database. A malformed id gets `400 INVALID_ACCOUNT_ID`; a well-formed id that doesn't exist gets `404 ACCOUNT_NOT_FOUND`.
3. **Duplicate `reference_id` returns `409 Conflict`** with the original transaction in `error.details.transaction`. The duplicate is detected by `(account_id, reference_id)` alone; the rest of the payload isn't compared.
4. **Insufficient balance returns `422`** and leaves the balance unchanged.
5. **Pagination:** `page` defaults to 1 and `limit` to 10, with a maximum `limit` of 100. Values that aren't positive integers return `400`. A page past the end returns an empty list, not an error.
6. **Sorting:** newest first by `created_at`, with ties broken by insertion order. `created_at` uses `clock_timestamp()`, so two rows written in the same DB transaction still get different times.
7. **Transfers** are recorded as two linked transactions (a debit and a credit) that share a `transfer_id`. Each leg's `reference_id` is `transfer:{reference_id}` and is unique per account like any other. The transfer's `reference_id` is optional and unique per source account.
8. **Unknown fields in a request body are rejected** (`400`), so a client can't sneak in `balance`, `id` or `created_at`.
9. **Accounts can't be deleted or renamed.** The brief doesn't ask for it, and deleting one would orphan its ledger.
10. **No authentication or authorisation.** It's out of scope for the brief. In production every route would need auth, and an account would be visible only to its owner.
11. **Timestamps are UTC** (ISO-8601 with `Z`).

## Deployment

The suggested free setup uses Supabase for the database, Render for the API and Netlify for the frontend.

1. **Supabase:**
   - Create a project.
   - Copy the **Session pooler** connection string.
   - The schema is created automatically when the API first starts.
2. **Render:**
   - Create a new **Web Service** from this repo (`render.yaml` is included).
   - Build: `npm ci && npm run build`. Start: `npm start`.
   - Env vars: `DATABASE_URL=<supabase uri>` and `DATABASE_SSL=true`.
   - The free instance sleeps after 15 minutes idle, so the first request can take about a minute.
3. **Netlify (optional):**
   - Set `window.API_BASE_URL` in `public/config.js` to the Render URL.
   - Import the repo. `netlify.toml` publishes `public/`, with no build step.
   - The API also serves the same page at `/`, so this step is optional.

On AWS, the same pieces map to App Runner or Elastic Beanstalk for the API, S3 + CloudFront or Amplify for `public/`, and RDS Postgres or Supabase for the database. Secrets go in environment variables or Secrets Manager.

### Scaling notes

- History queries use the index `(account_id, created_at DESC, seq DESC)`.
- For very long histories, keyset (cursor) pagination would replace `OFFSET`.
- Row locks are per account, so traffic on different accounts runs in parallel.
