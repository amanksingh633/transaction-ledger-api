import { toRupees } from '../lib/money';

// Postgres returns BIGINT as a string; these convert DB rows to API objects (paise -> rupees).

export interface AccountRow {
  id: string;
  name: string;
  balance: string;
  created_at: Date;
}

export interface TransactionRow {
  id: string;
  account_id: string;
  type: 'credit' | 'debit';
  amount: string;
  description: string | null;
  reference_id: string;
  transfer_id: string | null;
  created_at: Date;
}

export interface TransferRow {
  id: string;
  from_account_id: string;
  to_account_id: string;
  amount: string;
  description: string | null;
  reference_id: string;
  created_at: Date;
}

export const TRANSACTION_COLUMNS =
  'id, account_id, type, amount, description, reference_id, transfer_id, created_at';

export const toAccount = (row: AccountRow) => ({
  id: row.id,
  name: row.name,
  balance: toRupees(row.balance),
  created_at: row.created_at,
});

export const toTransaction = (row: TransactionRow) => ({
  id: row.id,
  account_id: row.account_id,
  type: row.type,
  amount: toRupees(row.amount),
  description: row.description,
  reference_id: row.reference_id,
  transfer_id: row.transfer_id,
  created_at: row.created_at,
});

export const toTransfer = (row: TransferRow) => ({
  id: row.id,
  from_account_id: row.from_account_id,
  to_account_id: row.to_account_id,
  amount: toRupees(row.amount),
  description: row.description,
  reference_id: row.reference_id,
  created_at: row.created_at,
});

export function pageMeta(page: number, limit: number, totalRecords: number) {
  return {
    current_page: page,
    page_size: limit,
    total_records: totalRecords,
    total_pages: Math.ceil(totalRecords / limit),
  };
}
