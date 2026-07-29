/**
 * Client for the Avarda MyPages API (the platform behind TF Bank Italy and
 * other banks' customer areas). Plain JSON over HTTPS, no browser.
 *
 * Login is two steps:
 *   1. validate     -> sessionId    (the bank sends an SMS code)
 *   2. authenticate -> accessToken  (short-lived JWT, ~5 min)
 *
 * The caller supplies the SMS code through a `getOtp` callback. Card data
 * (transactions, invoices, limits) is read from a second host with the token.
 */

export interface AvardaMyPagesConfig {
  /** Per-bank site identifier sent with every identity call. */
  siteKey: string;
  /** Identity host (login / token). */
  identityBaseUrl?: string;
  /** Card-management host (transactions / invoices / limits). */
  cardBaseUrl?: string;
  /** Value used for the Origin/Referer headers the API expects. */
  origin?: string;
  /** Injectable fetch (defaults to the global). Useful for tests or older runtimes. */
  fetchImpl?: typeof fetch;
}

/** Ready-made config for TF Bank Italy (areacliente.tfbank.it). */
export const TF_BANK_ITALY: Required<Omit<AvardaMyPagesConfig, 'fetchImpl'>> = {
  siteKey: '019773ac-7f3a-4768-ba73-e43697e32120',
  identityBaseUrl: 'https://mypages-api.production.avarda.com',
  cardBaseUrl: 'https://cardmanagement.production.avarda.com',
  origin: 'https://areacliente.tfbank.it',
};

export interface LoginParams {
  email: string;
  password: string;
  /**
   * Returns the SMS one-time code. Called after `validate` has triggered the
   * text. May be async (e.g. wait on a webhook). Throw or return empty to abort.
   */
  getOtp: () => string | Promise<string>;
}

export interface Session {
  accessToken: string;
  /** Unix ms expiry, decoded from the JWT `exp` claim when present. */
  expiresAt: number | null;
  /** Decoded JWT payload (sub/email, ssn, market, ...), best-effort. */
  claims: Record<string, unknown> | null;
}

/**
 * Locale values the card API accepts. It is an enum, not a BCP-47 tag: passing
 * `it-IT`, `it`, `en-US` or similar is rejected with
 * `The value '...' is not valid for Locale.`
 *
 * The Italian site maps every language except Spanish onto `EnGB`, which only
 * affects the language of server-rendered transaction text.
 */
export type AvardaLocale = 'EnGB' | 'EsES' | 'ItIT' | 'SvSE' | 'DeDE' | 'DeAT';

export interface TransactionsParams {
  /** From {@link AvardaMyPages.getCards}; not the login email. */
  cornicheAccountId: string;
  /** Inclusive start, `YYYY-MM-DD`. */
  transactionDateFrom: string;
  /** Inclusive end, `YYYY-MM-DD`. */
  transactionDateTo: string;
  /** Optional server-side filter on merchant. */
  merchantName?: string;
  /** Defaults to `EnGB`, which is what the Italian site sends. */
  locale?: AvardaLocale;
}

/** A card as returned by `/api/v1/config`. */
export interface CardConfigCard {
  /** Addresses transactions. */
  cornicheAccountId: string;
  /** Addresses the card (overview, credit limits, PIN). */
  cornicheCardPan: string;
  state?: string;
  debitBlock?: boolean;
  [key: string]: unknown;
}

export interface CardConfig {
  customer?: { cards?: CardConfigCard[]; [key: string]: unknown };
  [key: string]: unknown;
}

/** Error carrying the HTTP status and parsed/raw body for diagnosis. */
export class AvardaMyPagesError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'AvardaMyPagesError';
  }
}

/** Portable base64url decode that works in browsers and Node (16+) without Buffer. */
function base64UrlDecode(input: string): string {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const g = globalThis as { atob?: (s: string) => string; Buffer?: { from(s: string, e: string): { toString(e: string): string } } };
  if (typeof g.atob === 'function') {
    const binary = g.atob(b64);
    try {
      // Recover UTF-8 from the binary string (JWT claims are usually ASCII, but be safe).
      return decodeURIComponent(
        Array.from(binary)
          .map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
          .join(''),
      );
    } catch {
      return binary;
    }
  }
  if (g.Buffer) return g.Buffer.from(b64, 'base64').toString('utf8');
  throw new Error('No base64 decoder available in this runtime.');
}

function decodeJwt(token: string): { exp: number | null; claims: Record<string, unknown> | null } {
  try {
    const payload = token.split('.')[1];
    if (!payload) return { exp: null, claims: null };
    const claims = JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    return { exp, claims };
  } catch {
    return { exp: null, claims: null };
  }
}

export class AvardaMyPages {
  private readonly siteKey: string;
  private readonly identityBaseUrl: string;
  private readonly cardBaseUrl: string;
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  private session: Session | null = null;

  constructor(config: AvardaMyPagesConfig) {
    this.siteKey = config.siteKey;
    this.identityBaseUrl = (config.identityBaseUrl ?? TF_BANK_ITALY.identityBaseUrl).replace(/\/$/, '');
    this.cardBaseUrl = (config.cardBaseUrl ?? TF_BANK_ITALY.cardBaseUrl).replace(/\/$/, '');
    this.origin = config.origin ?? TF_BANK_ITALY.origin;
    const f = config.fetchImpl ?? globalThis.fetch;
    if (!f) {
      throw new Error('No fetch available. Pass fetchImpl or run on Node 18+.');
    }
    this.fetchImpl = f;
  }

  /** The current session, or null before login. */
  getSession(): Session | null {
    return this.session;
  }

  get accessToken(): string | null {
    return this.session?.accessToken ?? null;
  }

  /** True when a token exists and is not within `skewMs` of expiring. */
  isTokenValid(skewMs = 15_000): boolean {
    if (!this.session) return false;
    if (this.session.expiresAt == null) return true;
    return Date.now() + skewMs < this.session.expiresAt;
  }

  private headers(auth = false): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: this.origin,
      Referer: this.origin.endsWith('/') ? this.origin : `${this.origin}/`,
    };
    if (auth) {
      if (!this.session) throw new Error('Not authenticated. Call login() first.');
      h.Authorization = `Bearer ${this.session.accessToken}`;
    }
    return h;
  }

  private async request<T>(
    baseUrl: string,
    path: string,
    opts: { method?: string; body?: unknown; auth?: boolean; raw?: boolean } = {},
  ): Promise<T> {
    const { method = 'GET', body, auth = false, raw = false } = opts;
    const res = await this.fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: this.headers(auth),
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (raw) {
      if (!res.ok) {
        throw new AvardaMyPagesError(`${method} ${path} failed (${res.status})`, res.status, await res.text().catch(() => ''));
      }
      return (await res.arrayBuffer()) as unknown as T;
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      throw new AvardaMyPagesError(`${method} ${path} failed (${res.status})`, res.status, parsed);
    }
    return parsed as T;
  }

  private setSession(accessToken: string): Session {
    const { exp, claims } = decodeJwt(accessToken);
    this.session = { accessToken, expiresAt: exp, claims };
    return this.session;
  }

  // ---- Identity ----------------------------------------------------------

  /**
   * Step 1 of login. Returns a `sessionId` and, as a side effect, causes the
   * bank to text an OTP to the account's phone. Rarely called directly; use
   * {@link login}. Note: Avarda rate-limits SMS after several attempts.
   */
  async validate(email: string, password: string): Promise<{ sessionId: string }> {
    return this.request(this.identityBaseUrl, '/api/Identity/password/validate', {
      method: 'POST',
      body: { siteKey: this.siteKey, email, password },
    });
  }

  /**
   * Step 2 of login. Exchanges the OTP + sessionId for an access token and
   * stores the session on this client.
   */
  async authenticate(email: string, otp: string, sessionId: string): Promise<Session> {
    const { accessToken } = await this.request<{ accessToken: string }>(
      this.identityBaseUrl,
      '/api/Identity/password/authenticate',
      { method: 'POST', body: { siteKey: this.siteKey, email, otp, sessionId } },
    );
    return this.setSession(accessToken);
  }

  /** Full login: validate -> getOtp() -> authenticate. Returns the session. */
  async login({ email, password, getOtp }: LoginParams): Promise<Session> {
    const { sessionId } = await this.validate(email, password);
    const otp = (await getOtp())?.trim();
    if (!otp) throw new Error('getOtp() returned no code.');
    return this.authenticate(email, otp, sessionId);
  }

  /** Refresh the short-lived access token. */
  async refreshToken(): Promise<Session> {
    const { accessToken } = await this.request<{ accessToken: string }>(
      this.identityBaseUrl,
      '/api/Identity/token/refresh',
      { method: 'POST', body: {}, auth: true },
    );
    return this.setSession(accessToken);
  }

  // ---- Card data ---------------------------------------------------------

  /**
   * Card configuration, and the only source of the card identifiers.
   *
   * `cornicheAccountId` addresses transactions and `cornicheCardPan` addresses
   * the card itself. Nothing else exposes them: they are absent from the JWT
   * claims, and the identity host's account endpoints return empty arrays for
   * card-only customers.
   */
  async getConfig<T = CardConfig>(): Promise<T> {
    return this.request<T>(this.cardBaseUrl, '/api/v1/config', { auth: true });
  }

  /**
   * The cards on this customer, straight out of {@link getConfig}. Convenience
   * for the common case of "which ids do I pass to everything else".
   */
  async getCards(): Promise<CardConfigCard[]> {
    const config = await this.getConfig();
    return config?.customer?.cards ?? [];
  }

  /**
   * Credit limit, balance and repayment details.
   *
   * `cornicheCardPan` scopes the response to one card; omitting it works for
   * single-card customers.
   */
  async getCreditLimits<T = unknown>(cornicheCardPan?: string): Promise<T> {
    const query = cornicheCardPan
      ? `?cornicheCardPan=${encodeURIComponent(cornicheCardPan)}`
      : '';
    return this.request<T>(this.cardBaseUrl, `/api/v1/CreditLimit/GetCreditLimits${query}`, { auth: true });
  }

  /**
   * Card overview (balance/limit plus a few recent transactions).
   *
   * Keyed by `cornicheCardPan`, not by the account id.
   */
  async getCardOverview<T = unknown>(cornicheCardPan: string, numberOfTransactions = 3): Promise<T> {
    return this.request<T>(
      this.cardBaseUrl,
      `/api/v3/CreditCard/overview/${encodeURIComponent(cornicheCardPan)}?numberOfTransactions=${numberOfTransactions}`,
      { auth: true },
    );
  }

  /**
   * Card transactions for a date window.
   *
   * All three of `transactionDateFrom`, `transactionDateTo` and `locale` are
   * required: the API answers 400 with a validation list if any is missing or
   * malformed. `locale` is an enum ({@link AvardaLocale}), not a BCP-47 tag, so
   * `it-IT` is rejected -- the Italian site itself sends `EnGB`.
   */
  async getTransactions<T = unknown>(params: TransactionsParams): Promise<T> {
    const { cornicheAccountId, transactionDateFrom, transactionDateTo, merchantName, locale = 'EnGB' } = params;
    const query = new URLSearchParams({ transactionDateFrom, transactionDateTo, locale });
    if (merchantName) query.append('merchantName', merchantName);
    return this.request<T>(
      this.cardBaseUrl,
      `/api/v3/transactions/${encodeURIComponent(cornicheAccountId)}?${query.toString()}`,
      { auth: true },
    );
  }

  /** Detail for a single transaction. `transactionType` comes off the list row. */
  async getTransactionDetails<T = unknown>(transactionId: string, transactionType?: string): Promise<T> {
    const query = transactionType ? `?TransactionType=${encodeURIComponent(transactionType)}` : '';
    return this.request<T>(
      this.cardBaseUrl,
      `/api/v3/transactions/details/${encodeURIComponent(transactionId)}${query}`,
      { auth: true },
    );
  }

  /** Invoices (fatture): the historical statement list. */
  async getInvoices<T = unknown>(): Promise<T> {
    return this.request<T>(this.cardBaseUrl, '/api/v1/invoices', { auth: true });
  }

  /** Download a single invoice as a PDF (ArrayBuffer). */
  async downloadInvoice(invoiceId: string): Promise<ArrayBuffer> {
    return this.request<ArrayBuffer>(
      this.cardBaseUrl,
      `/api/v1/invoices/${encodeURIComponent(invoiceId)}/download`,
      { auth: true, raw: true },
    );
  }

  // ---- Account / client --------------------------------------------------

  /** Client profile (name/email/phone). */
  async getClientDetails<T = unknown>(): Promise<T> {
    return this.request<T>(this.identityBaseUrl, '/api/client/details', { auth: true });
  }
}

export default AvardaMyPages;
