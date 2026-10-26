import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { AppError, insufficientBalance } from '../lib/errors';
import { toPaise, toRupees } from '../lib/money';
import type { CreateTransferInput } from '../lib/validation';
import { changeBalance, lockAccount } from './accounts';
import { AccountRow, toTransaction, toTransfer, TransferRow } from './mappers';
import { insertTransaction } from './transactions';

const TRANSFER_COLUMNS = 'id, from_account_id, to_account_id, amount, description, reference_id, created_at';

/**
 * Moves money between two accounts. The transfer record, the debit on the
 * source, the credit on the destination and both balance updates are one
 * database transaction: if any step fails, none of them is saved.
 */
export async function createTransfer(input: CreateTransferInput) {
  const { from_account_id: fromId, to_account_id: toId } = input;
  if (fromId === toId) {
    throw new AppError(400, 'SAME_ACCOUNT_TRANSFER', 'from_account_id and to_account_id must be different accounts');
  }
  const amountPaise = toPaise(input.amount);
  const referenceId = input.reference_id ?? randomUUID();

  return withTransaction(async (client) => {
    // Lock both rows in a fixed (sorted) order. If A->B and B->A run at the same
    // time, both lock the same account first, so they cannot deadlock.
    const locked = new Map<string, AccountRow>();
    for (const id of [fromId, toId].sort()) {
      locked.set(id, await lockAccount(client, id));
    }
    const from = locked.get(fromId)!;

    const existing = await client.query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS} FROM transfers WHERE from_account_id = $1 AND reference_id = $2`,
      [fromId, referenceId],
    );
    if (existing.rows[0]) {
      throw new AppError(
        409,
        'DUPLICATE_TRANSFER',
        `A transfer with reference_id "${referenceId}" already exists for this source account`,
        { transfer: toTransfer(existing.rows[0]) },
      );
    }

    if (Number(from.balance) < amountPaise) {
      throw insufficientBalance(fromId, toRupees(from.balance), input.amount);
    }

    const { rows } = await client.query<TransferRow>(
      `INSERT INTO transfers (from_account_id, to_account_id, amount, description, reference_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${TRANSFER_COLUMNS}`,
      [fromId, toId, amountPaise, input.description, referenceId],
    );
    const transfer = rows[0];
    const legReference = `transfer:${referenceId}`;

    const debit = await insertTransaction(client, {
      accountId: fromId,
      type: 'debit',
      amountPaise,
      description: input.description ?? `Transfer to ${toId}`,
      referenceId: legReference,
      transferId: transfer.id,
    });
    const credit = await insertTransaction(client, {
      accountId: toId,
      type: 'credit',
      amountPaise,
      description: input.description ?? `Transfer from ${fromId}`,
      referenceId: legReference,
      transferId: transfer.id,
    });

    const fromBalance = await changeBalance(client, fromId, -amountPaise);
    const toBalance = await changeBalance(client, toId, amountPaise);

    return {
      transfer: toTransfer(transfer),
      debit_transaction: toTransaction(debit),
      credit_transaction: toTransaction(credit),
      from_account: { id: fromId, balance: toRupees(fromBalance) },
      to_account: { id: toId, balance: toRupees(toBalance) },
    };
  });
}
