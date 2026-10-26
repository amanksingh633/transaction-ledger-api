import request from 'supertest';
import { createApp } from '../src/app';
import { closePool, getPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';

export const app = createApp();
export const api = () => request(app);

export function useTestDatabase() {
  beforeAll(migrate);
  beforeEach(() => getPool().query('TRUNCATE transactions, transfers, accounts'));
  afterAll(closePool);
}

export async function createAccount(name = 'Test Account'): Promise<string> {
  const res = await api().post('/accounts').send({ name }).expect(201);
  return res.body.id;
}

let refCounter = 0;
export function post(accountId: string, type: string, amount: unknown, reference_id = `ref-${++refCounter}`) {
  return api().post(`/accounts/${accountId}/transactions`).send({ type, amount, reference_id });
}

export async function balanceOf(accountId: string): Promise<number> {
  const res = await api().get(`/accounts/${accountId}/balance`).expect(200);
  return res.body.balance;
}

/** Ledger invariant: stored balance === sum(credits) - sum(debits), checked straight in the DB. */
export async function expectBalanceMatchesLedger(accountId: string) {
  const { rows } = await getPool().query(
    `SELECT a.balance,
            COALESCE(SUM(CASE t.type WHEN 'credit' THEN t.amount ELSE -t.amount END), 0) AS ledger
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
      WHERE a.id = $1 GROUP BY a.id`,
    [accountId],
  );
  expect(Number(rows[0].balance)).toBe(Number(rows[0].ledger));
}

export const MISSING_ID = '00000000-0000-4000-8000-000000000000';
