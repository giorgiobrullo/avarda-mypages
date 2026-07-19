# avarda-mypages

A TypeScript client for the Avarda MyPages API — the platform behind the online
customer areas of several banks, including TF Bank Italy (`areacliente.tfbank.it`).

It talks to the same JSON API the web app uses, so there is no browser or
scraping involved. Login uses a password plus an SMS one-time code. You provide
the code through a `getOtp` callback; how you obtain it (a webhook, a prompt, an
inbox) is up to you.

## Install

```bash
npm install github:giorgiobrullo/avarda-mypages
```

Needs Node 18+ for the global `fetch`, or pass your own via `fetchImpl`. It runs
in the browser too, subject to CORS.

## Usage

```ts
import { AvardaMyPages, TF_BANK_ITALY } from 'avarda-mypages';

const client = new AvardaMyPages(TF_BANK_ITALY);

await client.login({
  email: 'you@example.com',
  password: 'secret',
  getOtp: () => waitForSmsCode(), // return the code sent by the bank
});

const limits = await client.getCreditLimits();
const accountId = /* read the id from `limits` */;

const transactions = await client.getTransactions(accountId);
const invoices = await client.getInvoices();
const pdf = await client.downloadInvoice(invoiceId); // ArrayBuffer
```

Login happens in two steps. `validate` submits the password and the bank sends
the SMS; `getOtp` returns that code; `authenticate` exchanges it for an access
token. `login()` runs all three for you.

### Another Avarda bank

`TF_BANK_ITALY` is a preset. For a different Avarda-serviced bank, pass its
`siteKey` and `origin`:

```ts
const client = new AvardaMyPages({
  siteKey: 'the-bank-site-key',
  origin: 'https://the-bank-customer-area',
});
```

`identityBaseUrl` and `cardBaseUrl` default to Avarda's production hosts.

## API

| Method | Description |
| --- | --- |
| `login({ email, password, getOtp })` | Runs validate → getOtp → authenticate. Returns the session. |
| `validate(email, password)` | Step 1. Returns `{ sessionId }` and triggers the SMS. |
| `authenticate(email, otp, sessionId)` | Step 2. Exchanges the code for a token and stores the session. |
| `refreshToken()` | Refreshes the short-lived access token. |
| `getCreditLimits()` | Accounts and credit limits. This is where the `accountId` comes from. |
| `getCardOverview(accountId)` | Balance and limit for one account. |
| `getTransactions(accountId)` | Recent card transactions. |
| `getTransactionDetails(txnId)` | One transaction in full. |
| `getInvoices()` | Invoice (fattura) list. |
| `downloadInvoice(invoiceId)` | Invoice PDF as an `ArrayBuffer`. |
| `getClientDetails()` | Name, email, phone. |
| `getSession()` / `accessToken` / `isTokenValid()` | Session inspection. |

Data methods are generic, e.g. `getTransactions<MyType>(id)`. The response
shapes are stable per bank but not typed by this library — declare your own
against what your account returns.

Failed requests throw `AvardaMyPagesError`, which carries `.status` and `.body`.

## Notes

- Avarda rate-limits the SMS after a few login attempts in a short window. Keep a
  session and call `refreshToken()` instead of logging in repeatedly.
- Access tokens are short-lived JWTs (about 5 minutes). `isTokenValid()` reads
  the decoded `exp`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
