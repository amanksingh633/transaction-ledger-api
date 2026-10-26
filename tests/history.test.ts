import { api, createAccount, MISSING_ID, post, useTestDatabase } from './helpers';

useTestDatabase();

async function accountWithHistory() {
  const id = await createAccount();
  // 5 credits then 3 debits, in this order
  for (let i = 1; i <= 5; i++) await post(id, 'credit', i * 10, `c${i}`).expect(201);
  for (let i = 1; i <= 3; i++) await post(id, 'debit', i, `d${i}`).expect(201);
  return id;
}

describe('GET /accounts/:id/transactions', () => {
  it('returns all transactions newest first, with default paging', async () => {
    const id = await accountWithHistory();
    const res = await api().get(`/accounts/${id}/transactions`).expect(200);

    expect(res.body.data.map((t: { reference_id: string }) => t.reference_id)).toEqual([
      'd3', 'd2', 'd1', 'c5', 'c4', 'c3', 'c2', 'c1',
    ]);
    expect(res.body.pagination).toEqual({ current_page: 1, page_size: 10, total_records: 8, total_pages: 1 });

    const times = res.body.data.map((t: { created_at: string }) => Date.parse(t.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('filters by type', async () => {
    const id = await accountWithHistory();
    const credits = await api().get(`/accounts/${id}/transactions?type=credit`).expect(200);
    expect(credits.body.data.every((t: { type: string }) => t.type === 'credit')).toBe(true);
    expect(credits.body.pagination.total_records).toBe(5);

    const debits = await api().get(`/accounts/${id}/transactions?type=debit`).expect(200);
    expect(debits.body.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['d3', 'd2', 'd1']);
  });

  it('paginates with page and limit', async () => {
    const id = await accountWithHistory();
    const page2 = await api().get(`/accounts/${id}/transactions?page=2&limit=3`).expect(200);
    expect(page2.body.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['c5', 'c4', 'c3']);
    expect(page2.body.pagination).toEqual({ current_page: 2, page_size: 3, total_records: 8, total_pages: 3 });

    const page3 = await api().get(`/accounts/${id}/transactions?page=3&limit=3`).expect(200);
    expect(page3.body.data).toHaveLength(2);
  });

  it('combines filter and pagination', async () => {
    const id = await accountWithHistory();
    const res = await api().get(`/accounts/${id}/transactions?type=credit&page=2&limit=2`).expect(200);
    expect(res.body.data.map((t: { reference_id: string }) => t.reference_id)).toEqual(['c3', 'c2']);
    expect(res.body.pagination).toEqual({ current_page: 2, page_size: 2, total_records: 5, total_pages: 3 });
  });

  it('returns an empty page past the end', async () => {
    const id = await accountWithHistory();
    const res = await api().get(`/accounts/${id}/transactions?page=99`).expect(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total_records).toBe(8);
  });

  it('returns an empty list for an account with no transactions', async () => {
    const id = await createAccount();
    const res = await api().get(`/accounts/${id}/transactions`).expect(200);
    expect(res.body).toEqual({
      data: [],
      pagination: { current_page: 1, page_size: 10, total_records: 0, total_pages: 0 },
    });
  });

  it.each(['page=0', 'page=-1', 'page=abc', 'page=1.5', 'limit=0', 'limit=101', 'limit=ten', 'page=1&page=2'])(
    'rejects invalid pagination: %s',
    async (qs) => {
      const id = await createAccount();
      const res = await api().get(`/accounts/${id}/transactions?${qs}`).expect(400);
      expect(res.body.error.code).toBe('INVALID_PAGINATION');
    },
  );

  it('rejects an invalid type filter', async () => {
    const id = await createAccount();
    const res = await api().get(`/accounts/${id}/transactions?type=refund`).expect(400);
    expect(res.body.error.code).toBe('INVALID_TRANSACTION_TYPE');
  });

  it('returns 404 for a missing account', async () => {
    const res = await api().get(`/accounts/${MISSING_ID}/transactions`).expect(404);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });
});
