import { Router } from 'express';
import { AppError } from '../lib/errors';
import {
  createAccountBody,
  createTransactionBody,
  paginationQuery,
  parse,
  parseAccountId,
  parseBody,
  transactionHistoryQuery,
} from '../lib/validation';
import { createAccount, getAccount, listAccounts } from '../services/accounts';
import { createTransaction, listTransactions } from '../services/transactions';

export const accountsRouter = Router();

// POST /accounts
accountsRouter.post('/', async (req, res) => {
  const { name } = parseBody(createAccountBody, req.body);
  res.status(201).json(await createAccount(name));
});

// GET /accounts?page=&limit=  (handy for the UI; newest first)
accountsRouter.get('/', async (req, res) => {
  res.json(await listAccounts(parse(paginationQuery, req.query, 'INVALID_PAGINATION')));
});

// GET /accounts/:id
accountsRouter.get('/:id', async (req, res) => {
  res.json(await getAccount(parseAccountId(req.params.id)));
});

// GET /accounts/:id/balance
accountsRouter.get('/:id/balance', async (req, res) => {
  const account = await getAccount(parseAccountId(req.params.id));
  res.json({ account_id: account.id, balance: account.balance, currency: 'INR' });
});

// POST /accounts/:id/transactions
accountsRouter.post('/:id/transactions', async (req, res) => {
  const accountId = parseAccountId(req.params.id);
  const input = parseBody(createTransactionBody, req.body);
  const { transaction, balance } = await createTransaction(accountId, input);
  res.status(201).json({ ...transaction, account_balance: balance });
});

// GET /accounts/:id/transactions?type=&page=&limit=
accountsRouter.get('/:id/transactions', async (req, res) => {
  const accountId = parseAccountId(req.params.id);
  const query = parse(transactionHistoryQuery, req.query);
  res.json(await listTransactions(accountId, query));
});

// Transactions are immutable: say so explicitly instead of a generic 404.
const immutable = ['/:id/transactions', '/:id/transactions/:transactionId'];
const rejectChange = (req: { method: string }) => {
  throw new AppError(
    405,
    'METHOD_NOT_ALLOWED',
    `${req.method} is not allowed: transactions cannot be edited or deleted once created`,
  );
};
accountsRouter.put(immutable, rejectChange);
accountsRouter.patch(immutable, rejectChange);
accountsRouter.delete(immutable, rejectChange);
