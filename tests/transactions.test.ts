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

describe('POST /accounts/:id/transactions', () => {
  it('credit increases the balance (100 + 50 = 150)', async () => {
    const id = await createAccount();
    await post(id, 'credit', 100).expect(201);
    const res = await post(id, 'credit', 50, 'salary-oct').expect(201);

    expect(res.body).toMatchObject({
      account_id: id,
      type: 'credit',
      amount: 50,
      reference_id: 'salary-oct',
      account_balance: 150,
    });
    expect(res.body.id).toBeDefined();
    expect(res.body.created_at).toBeDefined();
    expect(await balanceOf(id)).toBe(150);
  });

  it('debit decreases the balance (100 - 30 = 70)', async () => {
    const id = await createAccount();
    await post(id, 'credit', 100).expect(201);
    await post(id, 'debit', 30).expect(201);
    expect(await balanceOf(id)).toBe(70);
  });

  it('rejects a debit larger than the balance and leaves the balance unchanged', async () => {
    const id = await createAccount();
    await post(id, 'credit', 100).expect(201);
    const res = await post(id, 'debit', 150).expect(422);

    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { balance: 100, requested: 150 },
    });
    expect(await balanceOf(id)).toBe(100);
    const history = await api().get(`/accounts/${id}/transactions`);
    expect(history.body.pagination.total_records).toBe(1); // the rejected debit was not saved
  });

  it('allows a debit of exactly the full balance', async () => {
    const id = await createAccount();
    await post(id, 'credit', 100).expect(201);
    await post(id, 'debit', 100).expect(201);
    expect(await balanceOf(id)).toBe(0);
  });

  it('matches the brief: 0 + 100 + 50 - 30 - 20 = 100, and balance always equals the ledger', async () => {
    const id = await createAccount();
    await post(id, 'credit', 100).expect(201);
    await post(id, 'credit', 50).expect(201);
    await post(id, 'debit', 30).expect(201);
    await post(id, 'debit', 999).expect(422); // rejected: must not affect anything
    await post(id, 'debit', 20).expect(201);
    expect(await balanceOf(id)).toBe(100);
    await expectBalanceMatchesLedger(id);
  });

  it('handles paise exactly (0.1 + 0.2 = 0.3)', async () => {
    const id = await createAccount();
    await post(id, 'credit', 0.1).expect(201);
    await post(id, 'credit', 0.2).expect(201);
    expect(await balanceOf(id)).toBe(0.3);
  });

  describe('duplicate reference_id', () => {
    it('does not create a second transaction or change the balance; returns 409 with the original', async () => {
      const id = await createAccount();
      const first = await post(id, 'credit', 100, 'INV-1').expect(201);
      const again = await post(id, 'credit', 100, 'INV-1').expect(409);

      expect(again.body.error.code).toBe('DUPLICATE_TRANSACTION');
      expect(again.body.error.details.transaction.id).toBe(first.body.id);
      expect(await balanceOf(id)).toBe(100);
      const history = await api().get(`/accounts/${id}/transactions`);
      expect(history.body.pagination.total_records).toBe(1);
    });

    it('reports a retried debit as duplicate, not as insufficient balance', async () => {
      const id = await createAccount();
      await post(id, 'credit', 100).expect(201);
      await post(id, 'debit', 80, 'PAY-1').expect(201);
      const retry = await post(id, 'debit', 80, 'PAY-1').expect(409);
      expect(retry.body.error.code).toBe('DUPLICATE_TRANSACTION');
      expect(await balanceOf(id)).toBe(20);
    });

    it('allows the same reference_id on different accounts', async () => {
      const a = await createAccount('A');
      const b = await createAccount('B');
      await post(a, 'credit', 10, 'SHARED').expect(201);
      await post(b, 'credit', 10, 'SHARED').expect(201);
    });
  });

  describe('validation', () => {
    it('returns 404 when the account does not exist', async () => {
      const res = await post(MISSING_ID, 'credit', 10).expect(404);
      expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
    });

    it('returns 400 for a malformed account id', async () => {
      const res = await post('abc', 'credit', 10).expect(400);
      expect(res.body.error.code).toBe('INVALID_ACCOUNT_ID');
    });

    it.each(['refund', 'CREDIT', '', null, undefined])('rejects type %p', async (type) => {
      const id = await createAccount();
      const res = await post(id, type as string, 10).expect(400);
      expect(res.body.error.code).toBe('INVALID_TRANSACTION_TYPE');
    });

    it.each([0, -5, '10', null, undefined, 10.555, Number.MAX_SAFE_INTEGER])('rejects amount %p', async (amount) => {
      const id = await createAccount();
      const res = await post(id, 'credit', amount).expect(400);
      expect(res.body.error.code).toBe('INVALID_AMOUNT');
    });

    it.each([undefined, '', '   ', 7])('rejects reference_id %p', async (reference_id) => {
      const id = await createAccount();
      const res = await api()
        .post(`/accounts/${id}/transactions`)
        .send({ type: 'credit', amount: 10, reference_id })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST_BODY');
      expect(res.body.error.message).toMatch(/reference_id/);
    });

    it('rejects unknown fields such as account_id or balance in the body', async () => {
      const id = await createAccount();
      const res = await api()
        .post(`/accounts/${id}/transactions`)
        .send({ type: 'credit', amount: 10, reference_id: 'x', balance: 999 })
        .expect(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST_BODY');
    });

    it('leaves the balance untouched after any rejected request', async () => {
      const id = await createAccount();
      await post(id, 'credit', 50).expect(201);
      await post(id, 'credit', -1).expect(400);
      await post(id, 'bogus', 10).expect(400);
      expect(await balanceOf(id)).toBe(50);
      await expectBalanceMatchesLedger(id);
    });
  });
});

describe('immutability', () => {
  it('has no API to edit or delete a transaction', async () => {
    const id = await createAccount();
    const tx = await post(id, 'credit', 10).expect(201);
    await api().put(`/accounts/${id}/transactions/${tx.body.id}`).send({ amount: 1 }).expect(405);
    await api().patch(`/accounts/${id}/transactions/${tx.body.id}`).send({ amount: 1 }).expect(405);
    await api().delete(`/accounts/${id}/transactions/${tx.body.id}`).expect(405);
    await api().delete(`/accounts/${id}/transactions`).expect(405);
  });

  it('is enforced by the database even if code tried to change a row', async () => {
    const id = await createAccount();
    const tx = await post(id, 'credit', 10).expect(201);
    await expect(getPool().query('UPDATE transactions SET amount = 1 WHERE id = $1', [tx.body.id])).rejects.toThrow(
      /immutable/,
    );
    await expect(getPool().query('DELETE FROM transactions WHERE id = $1', [tx.body.id])).rejects.toThrow(/immutable/);
  });

  it('database constraints reject a negative balance and a non-positive amount', async () => {
    const id = await createAccount();
    await expect(getPool().query('UPDATE accounts SET balance = -1 WHERE id = $1', [id])).rejects.toThrow(
      /accounts_balance_check/,
    );
    await expect(
      getPool().query(
        `INSERT INTO transactions (account_id, type, amount, reference_id) VALUES ($1, 'credit', 0, 'z')`,
        [id],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('concurrency', () => {
  it('two simultaneous 80 debits on a 100 balance: exactly one succeeds', async () => {
    const id = await createAccount();
    await post(id, 'credit', 100).expect(201);

    const results = await Promise.all([post(id, 'debit', 80), post(id, 'debit', 80)]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 422]);
    expect(await balanceOf(id)).toBe(20);
    await expectBalanceMatchesLedger(id);
  });

  it('many simultaneous debits never overdraw the account', async () => {
    const id = await createAccount();
    await post(id, 'credit', 100).expect(201);

    const results = await Promise.all(Array.from({ length: 15 }, () => post(id, 'debit', 10)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(5);
    expect(await balanceOf(id)).toBe(0);
    await expectBalanceMatchesLedger(id);
  });

  it('the same reference_id sent twice at once is applied only once', async () => {
    const id = await createAccount();
    const results = await Promise.all([post(id, 'credit', 100, 'ONCE'), post(id, 'credit', 100, 'ONCE')]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await balanceOf(id)).toBe(100);
  });
});
