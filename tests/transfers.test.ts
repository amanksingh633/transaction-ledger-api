import { getPool } from '../src/db/pool';
import {
  api,
  balanceOf,
  createAccount,
  expectBalanceMatchesLedger,
  MISSING_ID,
  post,
  useTestDatabase,
} from './helpers';

useTestDatabase();

const transfer = (body: object) => api().post('/transfers').send(body);

async function accounts(aBalance: number, bBalance: number) {
  const a = await createAccount('A');
  const b = await createAccount('B');
  if (aBalance) await post(a, 'credit', aBalance).expect(201);
  if (bBalance) await post(b, 'credit', bBalance).expect(201);
  return { a, b };
}

describe('POST /transfers', () => {
  it('matches the brief: A 100, B 50, transfer 30 -> A 70, B 80', async () => {
    const { a, b } = await accounts(100, 50);
    const res = await transfer({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 'T-1' }).expect(201);

    expect(res.body.from_account).toEqual({ id: a, balance: 70 });
    expect(res.body.to_account).toEqual({ id: b, balance: 80 });
    expect(res.body.debit_transaction).toMatchObject({ account_id: a, type: 'debit', amount: 30 });
    expect(res.body.credit_transaction).toMatchObject({ account_id: b, type: 'credit', amount: 30 });
    expect(res.body.debit_transaction.transfer_id).toBe(res.body.transfer.id);
    expect(res.body.credit_transaction.transfer_id).toBe(res.body.transfer.id);

    expect(await balanceOf(a)).toBe(70);
    expect(await balanceOf(b)).toBe(80);
    await expectBalanceMatchesLedger(a);
    await expectBalanceMatchesLedger(b);
  });

  it('shows both legs in each account history', async () => {
    const { a, b } = await accounts(100, 0);
    await transfer({ from_account_id: a, to_account_id: b, amount: 30 }).expect(201);
    const historyB = await api().get(`/accounts/${b}/transactions`).expect(200);
    expect(historyB.body.data[0]).toMatchObject({ type: 'credit', amount: 30 });
  });

  it('rejects insufficient balance and changes nothing', async () => {
    const { a, b } = await accounts(100, 50);
    const res = await transfer({ from_account_id: a, to_account_id: b, amount: 150 }).expect(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balanceOf(a)).toBe(100);
    expect(await balanceOf(b)).toBe(50);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM transfers');
    expect(rows[0].n).toBe(0);
  });

  it('requires both accounts to exist', async () => {
    const { a } = await accounts(100, 0);
    const toMissing = await transfer({ from_account_id: a, to_account_id: MISSING_ID, amount: 10 }).expect(404);
    expect(toMissing.body.error).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', details: { account_id: MISSING_ID } });
    await transfer({ from_account_id: MISSING_ID, to_account_id: a, amount: 10 }).expect(404);
    expect(await balanceOf(a)).toBe(100);
  });

  it('rejects a transfer to the same account', async () => {
    const { a } = await accounts(100, 0);
    const res = await transfer({ from_account_id: a, to_account_id: a, amount: 10 }).expect(400);
    expect(res.body.error.code).toBe('SAME_ACCOUNT_TRANSFER');
  });

  it('validates amount and ids', async () => {
    const { a, b } = await accounts(100, 0);
    expect((await transfer({ from_account_id: a, to_account_id: b, amount: 0 })).body.error.code).toBe('INVALID_AMOUNT');
    expect((await transfer({ from_account_id: 'x', to_account_id: b, amount: 1 })).body.error.code).toBe(
      'INVALID_ACCOUNT_ID',
    );
    expect((await transfer({ to_account_id: b, amount: 1 })).status).toBe(400);
  });

  it('treats a repeated reference_id from the same source as a duplicate', async () => {
    const { a, b } = await accounts(100, 0);
    const first = await transfer({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 'T-9' }).expect(201);
    const again = await transfer({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 'T-9' }).expect(409);
    expect(again.body.error.code).toBe('DUPLICATE_TRANSFER');
    expect(again.body.error.details.transfer.id).toBe(first.body.transfer.id);
    expect(await balanceOf(a)).toBe(70);
    expect(await balanceOf(b)).toBe(30);
  });

  it('rolls back everything if a later step fails (no partial transfer)', async () => {
    const { a, b } = await accounts(100, 0);
    // Make the credit leg fail: B already has a transaction with the reference the credit leg will use.
    await post(b, 'credit', 1, 'transfer:T-ROLLBACK').expect(201);

    const res = await transfer({ from_account_id: a, to_account_id: b, amount: 30, reference_id: 'T-ROLLBACK' });
    expect(res.status).toBe(409);

    // The debit on A and the transfer row were written before the failure, but were rolled back.
    expect(await balanceOf(a)).toBe(100);
    expect(await balanceOf(b)).toBe(1);
    const { rows } = await getPool().query('SELECT count(*)::int AS n FROM transfers');
    expect(rows[0].n).toBe(0);
    await expectBalanceMatchesLedger(a);
    await expectBalanceMatchesLedger(b);
  });

  it('opposite transfers at the same time do not deadlock and keep totals intact', async () => {
    const { a, b } = await accounts(1000, 1000);
    const requests = Array.from({ length: 20 }, (_, i) =>
      i % 2
        ? transfer({ from_account_id: a, to_account_id: b, amount: 10 })
        : transfer({ from_account_id: b, to_account_id: a, amount: 5 }),
    );
    const results = await Promise.all(requests);
    expect(results.every((r) => r.status === 201)).toBe(true);

    expect(await balanceOf(a)).toBe(1000 - 10 * 10 + 10 * 5);
    expect(await balanceOf(b)).toBe(1000 + 10 * 10 - 10 * 5);
    await expectBalanceMatchesLedger(a);
    await expectBalanceMatchesLedger(b);
  });

  it('simultaneous transfers cannot overdraw the source', async () => {
    const { a, b } = await accounts(100, 0);
    const results = await Promise.all([
      transfer({ from_account_id: a, to_account_id: b, amount: 80 }),
      transfer({ from_account_id: a, to_account_id: b, amount: 80 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect((await balanceOf(a)) + (await balanceOf(b))).toBe(100);
  });
});
