import 'dotenv/config';

// Tests always run against the separate test database, which they wipe.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ledger_test';
