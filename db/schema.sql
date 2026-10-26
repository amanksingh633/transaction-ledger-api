-- Transaction Ledger schema. Safe to run more than once.
-- Money is stored as BIGINT paise (1 INR = 100 paise), never as a float.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on Postgres < 13

CREATE TABLE IF NOT EXISTS accounts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  balance     BIGINT      NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per transfer; its two legs live in `transactions` and point back here.
CREATE TABLE IF NOT EXISTS transfers (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  to_account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  amount           BIGINT      NOT NULL CHECK (amount > 0),
  description      TEXT,
  reference_id     TEXT        NOT NULL CHECK (length(btrim(reference_id)) > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT transfers_distinct_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT transfers_from_reference_unique UNIQUE (from_account_id, reference_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Insertion order; breaks ties when two rows share a created_at.
  seq           BIGINT      GENERATED ALWAYS AS IDENTITY,
  account_id    UUID        NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  type          TEXT        NOT NULL CHECK (type IN ('credit', 'debit')),
  amount        BIGINT      NOT NULL CHECK (amount > 0),
  description   TEXT,
  reference_id  TEXT        NOT NULL CHECK (length(btrim(reference_id)) > 0),
  transfer_id   UUID        REFERENCES transfers(id) ON DELETE RESTRICT,
  -- clock_timestamp() (not now()) so rows written in one DB transaction still differ.
  created_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Idempotency: a reference_id can be used once per account.
  CONSTRAINT transactions_account_reference_unique UNIQUE (account_id, reference_id)
);

-- Serves the history query: WHERE account_id = ? [AND type = ?] ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS transactions_account_created_idx
  ON transactions (account_id, created_at DESC, seq DESC);

-- Transactions are immutable: the database itself refuses UPDATE and DELETE,
-- so the rule holds even if application code has a bug.
CREATE OR REPLACE FUNCTION forbid_transaction_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'transactions are immutable: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_immutable ON transactions;
CREATE TRIGGER transactions_immutable
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_transaction_change();

DROP TRIGGER IF EXISTS transfers_immutable ON transfers;
CREATE TRIGGER transfers_immutable
  BEFORE UPDATE OR DELETE ON transfers
  FOR EACH ROW EXECUTE FUNCTION forbid_transaction_change();
