import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../db/pool';
import { accountNotFound, AppError, insufficientBalance } from '../lib/errors';
import { toPaise, toRupees } from '../lib/money';
import type { CreateTransactionInput, Pagination } from '../lib/validation';
import { changeBalance, lockAccount } from './accounts';
import { pageMeta, toTransaction, TRANSACTION_COLUMNS, TransactionRow } from './mappers';

interface NewTransaction {
  accountId: string;
  type: 'credit' | 'debit';
  amountPaise: number;
  description: string | null;
  referenceId: string;
  transferId?: string;
}

export async function insertTransaction(client: PoolClient, tx: NewTransaction): Promise<TransactionRow> {
  const { rows } = await client.query<TransactionRow>(
    `INSERT INTO transactions (account_id, type, amount, description, reference_id, transfer_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${TRANSACTION_COLUMNS}`,
    [tx.accountId, tx.type, tx.amountPaise, tx.description, tx.referenceId, tx.transferId ?? null],
  );
  return rows[0];
}

async function findByReference(client: PoolClient, accountId: string, referenceId: string) {
  const { rows } = await client.query<TransactionRow>(
    `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE account_id = $1 AND reference_id = $2`,
    [accountId, referenceId],
  );
  return rows[0];
}

/**
 * Records a credit or debit and updates the balance in ONE database transaction:
 * either both are saved or neither is.
 */
export async function createTransaction(accountId: string, input: CreateTransactionInput) {
  const amountPaise = toPaise(input.amount);

  return withTransaction(async (client) => {
    const account = await lockAccount(client, accountId);

    // Idempotency: a repeated reference_id must not create a second transaction.
    // Checked before the balance rule, so retrying an already-applied debit
    // reports "duplicate", not "insufficient balance".
    const existing = await findByReference(client, accountId, input.reference_id);
    if (existing) {
      throw new AppError(
        409,
        'DUPLICATE_TRANSACTION',
        `A transaction with reference_id "${input.reference_id}" already exists for this account`,
        { transaction: toTransaction(existing) },
      );
    }

    const balance = Number(account.balance);
    if (input.type === 'debit' && balance < amountPaise) {
      throw insufficientBalance(accountId, toRupees(balance), input.amount);
    }

    const row = await insertTransaction(client, {
      accountId,
      type: input.type,
      amountPaise,
      description: input.description,
      referenceId: input.reference_id,
    });
    const newBalance = await changeBalance(client, accountId, input.type === 'credit' ? amountPaise : -amountPaise);

    return { transaction: toTransaction(row), balance: toRupees(newBalance) };
  });
}

export async function listTransactions(
  accountId: string,
  { page, limit, type }: Pagination & { type?: 'credit' | 'debit' },
) {
  const pool = getPool();
  const exists = await pool.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
  if (exists.rowCount === 0) throw accountNotFound(accountId);

  // $2 is NULL when no type filter was given, which matches both types.
  const filter = 'account_id = $1 AND ($2::text IS NULL OR type = $2)';
  const [count, list] = await Promise.all([
    pool.query<{ total: string }>(`SELECT count(*) AS total FROM transactions WHERE ${filter}`, [accountId, type ?? null]),
    pool.query<TransactionRow>(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE ${filter}
       ORDER BY created_at DESC, seq DESC
       LIMIT $3 OFFSET $4`,
      [accountId, type ?? null, limit, (page - 1) * limit],
    ),
  ]);

  return { data: list.rows.map(toTransaction), pagination: pageMeta(page, limit, Number(count.rows[0].total)) };
}
