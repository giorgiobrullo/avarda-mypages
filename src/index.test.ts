import { describe, it, expect, vi } from 'vitest';

import { AvardaMyPages, TF_BANK_ITALY, AvardaMyPagesError } from './index';

/** Build a syntactically valid JWT with the given payload (signature ignored). */
function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const nowSecs = () => Math.floor(Date.now() / 1000);

describe('AvardaMyPages', () => {
  it('logs in: validate -> getOtp -> authenticate and stores the token', async () => {
    const token = jwt({ sub: 'you@example.com', exp: nowSecs() + 300 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: 'sess-1' })) // validate
      .mockResolvedValueOnce(json({ accessToken: token })); // authenticate
    const getOtp = vi.fn().mockResolvedValue('123456');

    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl });
    const session = await client.login({ email: 'you@example.com', password: 'pw', getOtp });

    expect(getOtp).toHaveBeenCalledOnce();
    expect(session.accessToken).toBe(token);
    expect(client.accessToken).toBe(token);
    expect(client.isTokenValid()).toBe(true);
    expect(session.claims?.sub).toBe('you@example.com');

    const [validateUrl, validateInit] = fetchImpl.mock.calls[0];
    expect(validateUrl).toBe(
      'https://mypages-api.production.avarda.com/api/Identity/password/validate',
    );
    expect(JSON.parse(validateInit.body)).toEqual({
      siteKey: TF_BANK_ITALY.siteKey,
      email: 'you@example.com',
      password: 'pw',
    });
    expect(validateInit.headers.Origin).toBe('https://areacliente.tfbank.it');
    expect(validateInit.headers.Referer).toBe('https://areacliente.tfbank.it/');

    const [authUrl, authInit] = fetchImpl.mock.calls[1];
    expect(authUrl).toContain('/api/Identity/password/authenticate');
    expect(JSON.parse(authInit.body)).toEqual({
      siteKey: TF_BANK_ITALY.siteKey,
      email: 'you@example.com',
      otp: '123456',
      sessionId: 'sess-1',
    });
  });

  it('sends the Bearer token on card-data calls', async () => {
    const token = jwt({ exp: nowSecs() + 300 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: 's' }))
      .mockResolvedValueOnce(json({ accessToken: token }))
      .mockResolvedValueOnce(json([{ accountId: 'acc-1' }]));

    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl });
    await client.login({ email: 'e', password: 'p', getOtp: () => '000000' });
    await client.getCreditLimits();

    const [url, init] = fetchImpl.mock.calls[2];
    expect(url).toBe(
      'https://cardmanagement.production.avarda.com/api/v1/CreditLimit/GetCreditLimits',
    );
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('throws AvardaMyPagesError carrying status and body on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ message: 'bad credentials' }, 400));
    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl });

    const err = await client.validate('e', 'p').catch(e => e);
    expect(err).toBeInstanceOf(AvardaMyPagesError);
    expect(err.status).toBe(400);
    expect(err.body).toEqual({ message: 'bad credentials' });
  });

  it('refuses card-data calls before login', async () => {
    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl: vi.fn() });
    await expect(client.getTransactions('acc')).rejects.toThrow(/Not authenticated/);
  });

  it('aborts login when getOtp returns nothing', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json({ sessionId: 's' }));
    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl });
    await expect(
      client.login({ email: 'e', password: 'p', getOtp: () => '' }),
    ).rejects.toThrow(/no code/);
  });

  it('returns an ArrayBuffer from downloadInvoice', async () => {
    const token = jwt({ exp: nowSecs() + 300 });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: 's' }))
      .mockResolvedValueOnce(json({ accessToken: token }))
      .mockResolvedValueOnce(
        new Response(pdf, { status: 200, headers: { 'content-type': 'application/pdf' } }),
      );

    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl });
    await client.login({ email: 'e', password: 'p', getOtp: () => '000000' });
    const buf = await client.downloadInvoice('inv-1');

    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(buf)).toEqual(pdf);
  });

  it('reports an expired token as invalid', async () => {
    const token = jwt({ exp: nowSecs() - 10 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: 's' }))
      .mockResolvedValueOnce(json({ accessToken: token }));

    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl });
    await client.login({ email: 'e', password: 'p', getOtp: () => '000000' });
    expect(client.isTokenValid()).toBe(false);
  });

  /** Log in and return [client, fetchImpl] with the two auth calls consumed. */
  async function loggedIn(...responses: Response[]) {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ sessionId: 's' }))
      .mockResolvedValueOnce(json({ accessToken: jwt({ exp: nowSecs() + 300 }) }));
    for (const response of responses) fetchImpl.mockResolvedValueOnce(response);
    const client = new AvardaMyPages({ ...TF_BANK_ITALY, fetchImpl });
    await client.login({ email: 'e', password: 'p', getOtp: () => '000000' });
    return [client, fetchImpl] as const;
  }

  it('reads card ids from /api/v1/config', async () => {
    const cards = [{ cornicheAccountId: 'acc-guid', cornicheCardPan: 'pan-guid', state: 'Active' }];
    const [client, fetchImpl] = await loggedIn(json({ customer: { cards } }));

    expect(await client.getCards()).toEqual(cards);
    expect(fetchImpl.mock.calls[2][0]).toBe(
      'https://cardmanagement.production.avarda.com/api/v1/config',
    );
  });

  it('returns no cards when the config payload is empty', async () => {
    const [client] = await loggedIn(json({}));
    expect(await client.getCards()).toEqual([]);
  });

  it('sends the date window and an enum locale when fetching transactions', async () => {
    const [client, fetchImpl] = await loggedIn(json({ transactions: [] }));

    await client.getTransactions({
      cornicheAccountId: 'acc-guid',
      transactionDateFrom: '2026-01-01',
      transactionDateTo: '2026-07-29',
    });

    const url = new URL(fetchImpl.mock.calls[2][0]);
    expect(url.pathname).toBe('/api/v3/transactions/acc-guid');
    expect(url.searchParams.get('transactionDateFrom')).toBe('2026-01-01');
    expect(url.searchParams.get('transactionDateTo')).toBe('2026-07-29');
    // `it-IT` is rejected by the API; the Italian site itself sends EnGB.
    expect(url.searchParams.get('locale')).toBe('EnGB');
    expect(url.searchParams.has('merchantName')).toBe(false);
  });

  it('appends merchantName only when given', async () => {
    const [client, fetchImpl] = await loggedIn(json({ transactions: [] }));

    await client.getTransactions({
      cornicheAccountId: 'acc-guid',
      transactionDateFrom: '2026-01-01',
      transactionDateTo: '2026-07-29',
      merchantName: 'Amazon',
      locale: 'ItIT',
    });

    const url = new URL(fetchImpl.mock.calls[2][0]);
    expect(url.searchParams.get('merchantName')).toBe('Amazon');
    expect(url.searchParams.get('locale')).toBe('ItIT');
  });

  it('scopes credit limits by card pan when one is given', async () => {
    const [client, fetchImpl] = await loggedIn(json({}), json({}));

    await client.getCreditLimits('pan-guid');
    expect(fetchImpl.mock.calls[2][0]).toBe(
      'https://cardmanagement.production.avarda.com/api/v1/CreditLimit/GetCreditLimits?cornicheCardPan=pan-guid',
    );

    await client.getCreditLimits();
    expect(fetchImpl.mock.calls[3][0]).toBe(
      'https://cardmanagement.production.avarda.com/api/v1/CreditLimit/GetCreditLimits',
    );
  });

  it('keys the card overview by pan, not by account id', async () => {
    const [client, fetchImpl] = await loggedIn(json({}));

    await client.getCardOverview('pan-guid', 10);
    expect(fetchImpl.mock.calls[2][0]).toBe(
      'https://cardmanagement.production.avarda.com/api/v3/CreditCard/overview/pan-guid?numberOfTransactions=10',
    );
  });
});
