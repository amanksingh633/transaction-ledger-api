import { api, MISSING_ID, useTestDatabase } from './helpers';

useTestDatabase();

describe('POST /accounts', () => {
  it('creates an account with a system id, zero balance and a timestamp', async () => {
    const res = await api().post('/accounts').send({ name: '  Aman  ' }).expect(201);
    expect(res.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Aman',
      balance: 0,
      created_at: expect.any(String),
    });
  });

  it('gives every account a unique id', async () => {
    const a = await api().post('/accounts').send({ name: 'A' });
    const b = await api().post('/accounts').send({ name: 'A' });
    expect(a.body.id).not.toBe(b.body.id);
  });

  it.each([
    [{}, 'name is required'],
    [{ name: '   ' }, 'name is required'],
    [{ name: 42 }, 'name must be a string'],
  ])('rejects a missing or invalid name: %j', async (body, message) => {
    const res = await api().post('/accounts').send(body).expect(400);
    expect(res.body.error).toMatchObject({ code: 'INVALID_REQUEST_BODY', message });
  });

  it('does not let the client set the balance (or id / created_at)', async () => {
    const res = await api().post('/accounts').send({ name: 'Rich', balance: 1_000_000 }).expect(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST_BODY');
    expect(res.body.error.message).toMatch(/balance is set by the server/);
  });

  it('rejects malformed JSON', async () => {
    const res = await api()
      .post('/accounts')
      .set('Content-Type', 'application/json')
      .send('{"name": ')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects a body that is not a JSON object', async () => {
    const res = await api().post('/accounts').send(['Aman']).expect(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST_BODY');
  });
});

describe('GET /accounts/:id/balance', () => {
  it('returns account_id and balance', async () => {
    const { body } = await api().post('/accounts').send({ name: 'A' });
    const res = await api().get(`/accounts/${body.id}/balance`).expect(200);
    expect(res.body).toEqual({ account_id: body.id, balance: 0, currency: 'INR' });
  });

  it('returns 404 for an account that does not exist', async () => {
    const res = await api().get(`/accounts/${MISSING_ID}/balance`).expect(404);
    expect(res.body.error).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', details: { account_id: MISSING_ID } });
  });

  it('returns 400 for a malformed account id', async () => {
    const res = await api().get('/accounts/not-a-uuid/balance').expect(400);
    expect(res.body.error.code).toBe('INVALID_ACCOUNT_ID');
  });
});

describe('error format', () => {
  it('uses the same shape for unknown routes', async () => {
    const res = await api().get('/nope').expect(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
  });
});
