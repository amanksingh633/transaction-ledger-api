import type { PoolClient } from 'pg';
import { getPool } from '../db/pool';
import { accountNotFound } from '../lib/errors';
import type { Pagination } from '../lib/validation';
import { AccountRow, pageMeta, toAccount } from './mappers';

export async function createAccount(name: string) {
  // balance and created_at come from column defaults; the client cannot set them.
  const { rows } = await getPool().query<AccountRow>(
    'INSERT INTO accounts (name) VALUES ($1) RETURNING id, name, balance, created_at',
    [name],
  );
  return toAccount(rows[0]);
}

export async function getAccount(accountId: string) {
  const { rows } = await getPool().query<AccountRow>(
    'SELECT id, name, balance, created_at FROM accounts WHERE id = $1',
    [accountId],
  );
  if (!rows[0]) throw accountNotFound(accountId);
  return toAccount(rows[0]);
}

export async function listAccounts({ page, limit }: Pagination) {
  const pool = getPool();
  const [count, list] = await Promise.all([
    pool.query<{ total: string }>('SELECT count(*) AS total FROM accounts'),
    pool.query<AccountRow>(
      'SELECT id, name, balance, created_at FROM accounts ORDER BY created_at DESC, id LIMIT $1 OFFSET $2',
      [limit, (page - 1) * limit],
    ),
  ]);
  return { data: list.rows.map(toAccount), pagination: pageMeta(page, limit, Number(count.rows[0].total)) };
}

/**
 * Reads the account and locks its row until the surrounding DB transaction ends.
 * Any other request that wants to change this account waits here, so balance
 * checks and updates for one account happen one at a time (no race conditions).
 */
export async function lockAccount(client: PoolClient, accountId: string): Promise<AccountRow> {
  const { rows } = await client.query<AccountRow>(
    'SELECT id, name, balance, created_at FROM accounts WHERE id = $1 FOR UPDATE',
    [accountId],
  );
  if (!rows[0]) throw accountNotFound(accountId);
  return rows[0];
}

export async function changeBalance(client: PoolClient, accountId: string, deltaPaise: number): Promise<number> {
  // The CHECK (balance >= 0) constraint rejects this if it would ever go negative.
  const { rows } = await client.query<{ balance: string }>(
    'UPDATE accounts SET balance = balance + $2 WHERE id = $1 RETURNING balance',
    [accountId, deltaPaise],
  );
  return Number(rows[0].balance);
}
