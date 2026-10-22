# dmarc-compass

A self-hosted dashboard for your **DMARC aggregate reports** and **SMTP TLS reports**, built to run entirely on Cloudflare (Workers, D1, Containers). Point your domains' `rua=` address at one mailbox, and dmarc-compass turns the stream of XML attachments into something you can actually read: who is sending as your domain, what is failing, and whether you're ready to move from `p=none` to `p=reject`.

- **Many domains, one mailbox.** Every query is domain-aware, with a searchable multi-select filter. Built with fleets of hundreds or thousands of domains in mind.
- **Enforcement readiness.** For the last 30 days, which sources fail alignment, and how many messages would have been quarantined or rejected if you tightened policy today.
- **Sender identification and trends.** Raw IPs become "Amazon SES", "Google Workspace" and so on. Volume and pass/fail are charted over time, and every source is plotted on a map.
- **TLS-RPT.** MTA-STS / DANE reports in the same place.
- **No server to run.** A fresh install is `git clone`, `npm install`, `npm run setup`.
- **Configured from the browser.** Mailbox credentials, dashboard visibility and manual syncs live on an authenticated `/admin` page. Credentials are encrypted before they are stored.

> **Status:** early. It does what is described here and nothing more; see [Limitations](#limitations).

## How it works

```
 receivers (Google, Microsoft, ...)         your domains' rua= address
            │  daily XML reports                      │
            └────────────────► one IMAP mailbox ◄─────┘
                                      │
                    ┌─────────────────▼──────────────────┐
                    │  Container: dmarc-report-viewer     │   parses mail + reports
                    │  (upstream project, unmodified)     │   (in memory, JSON API)
                    └─────────────────▲──────────────────┘
                                      │ every 15 min
                    ┌─────────────────┴──────────────────┐
                    │  Worker (this repo)                 │
                    │   • sync job  → writes to D1        │
                    │   • dashboard → reads from D1       │
                    │   • /admin    → settings, status    │
                    └─────────────────┬──────────────────┘
                                      ▼
                          D1 (the durable copy of your data)
```

The container is the parser and holds everything in memory; it forgets it on restart. The Worker copies each new report into **D1**, which is what the dashboard reads, so your history survives container restarts. D1 tables are created and upgraded automatically on the first request after each deploy. There is no migration step.

## What you need

| | |
|---|---|
| Cloudflare account on the **Workers Paid** plan | Containers are not available on the free plan. Budget roughly **$6–7/month**: the $5 plan fee plus about $1.75 of container memory and disk beyond the included allowance. The container runs continuously because the 15-minute sync keeps it awake. Check [current Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/). |
| **Docker** running locally | Wrangler uses it to build and push the container image at deploy time. |
| **Node.js 20+** | |
| A mailbox with **IMAP** | The one your domains send `rua=` reports to. |

## Install

```bash
git clone https://github.com/<you>/dmarc-compass.git
cd dmarc-compass
npm install
npm run setup
```

`npm run setup` logs you into Cloudflare if needed, deploys the Worker (Wrangler creates the D1 database for you), sets the admin login, and generates the encryption key. Passing `--dry-run` shows what it would do without changing anything. Setting your own password is optional: press Enter at the prompt and a strong one is generated and shown once.

Then open `https://<your-worker>.workers.dev/admin`, sign in, and enter your mailbox. Click **Run sync now**. The first sync takes about a minute while the container starts; after that it runs every 15 minutes.

Nothing in the repository is specific to your account. Wrangler records your resource IDs in `wrangler.local.jsonc`, which is gitignored.

### Point your domains at the mailbox

Each domain publishes a DMARC record. Start in monitoring mode:

```
_dmarc.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net"
```

If the reporting mailbox is on a **different domain** than the domain being reported on, the receiving side requires a one-time authorization record on the mailbox's domain, for each reported domain ([RFC 7489 §7.1](https://datatracker.ietf.org/doc/html/rfc7489#section-7.1)):

```
example.com._report._dmarc.reports.example.net.  TXT  "v=DMARC1"
```

A wildcard record (`*._report._dmarc.reports.example.net`) covers every domain at once if you manage many.

### Mailbox notes

Use an app-specific password wherever your provider offers one. `npm`-free sanity check: `python3 scripts/test-imap.py` logs in, lists the exact folder names, and counts messages, with no dependency on this project.

- **Gmail / Google Workspace:** `imap.gmail.com`, port 993. Needs 2-step verification and an app password.
- **Fastmail:** `imap.fastmail.com`, port 993, with an app password.
- **Zoho Mail:** `imap.zoho.com` for personal accounts, `imappro.zoho.com` for custom-domain accounts. IMAP must be enabled **both** in the user's mail settings **and** in the Zoho admin console. Log in with the account's **primary** address, not an alias.
- **Microsoft 365 / Outlook.com:** password-based IMAP is no longer offered, so this does not connect directly. The [upstream project documents a DavMail proxy](https://github.com/cry-inc/dmarc-report-viewer/tree/master/ms-365) as a workaround.

Folder names are case-sensitive. Reports are often filtered into a subfolder; enter its name in the Folder field.

## Using it

| Page | What it's for |
|---|---|
| **Overview** | Totals, pass/fail trend, volume by sender, sending sources, enforcement readiness. Filter by one, several or all domains. |
| **Domains** | One row per domain: policy, volume, pass rate, last report. |
| **DMARC reports** | Every report, filterable by DKIM/SPF problems, with per-record detail. |
| **TLS reports** | SMTP TLS (MTA-STS / DANE) results and failures. |
| **Sender map** | Where your mail is being sent from. |
| **Classic dashboard** (`/classic/`) | The upstream project's own UI, as a fallback and for raw XML/JSON export. |
| **/admin** | Setup status, mailbox settings, dashboard visibility, manual sync. Not linked from the nav; always requires login. |

### Who can see the dashboard

By default **every page requires the admin login**. In `/admin` you can switch on *"Allow anyone with the link to view the dashboard"*, which makes the read-only pages public. Those pages show your sending IPs, senders and pass rates, so decide whether that's acceptable before enabling it. `/admin` and `/classic/` are never public.

## Operating it

```bash
npm run deploy      # ship changes; also upgrades the database schema on first request
npm run dev         # local development (copy .dev.vars.example to .dev.vars first)
npm run tail        # live logs
npm run typecheck
```

**Updating:** `git pull && npm install && npm run deploy`. **The dashboard is empty:** open `/admin` and read *Setup status*. It names what is missing. If the mailbox looks right but nothing arrives, run `scripts/test-imap.py` to separate a mailbox problem from a deployment problem.

**Uninstalling:** `npx wrangler delete -c wrangler.local.jsonc`, then delete the D1 database and the container application from the Cloudflare dashboard.

## Security model

- The admin login is a Worker secret (`ADMIN_USER` / `ADMIN_PASSWORD`) compared on every request to `/admin`. It is HTTP Basic Auth, so always use the HTTPS `workers.dev` or custom-domain URL.
- Mailbox credentials entered on `/admin` are encrypted with AES-GCM using `CONFIG_ENCRYPTION_KEY`, a write-only Worker secret, before they reach D1. They are never sent back to the browser. **Do not rotate or lose that key without re-entering the mailbox password**: the stored value can no longer be decrypted.
- State-changing requests from `/admin` require a custom request header that a cross-site form cannot send (CSRF protection).
- The container is only reachable through the Worker, and its own UI is behind the same login.
- The public-dashboard switch defaults to **off**.

Found a vulnerability? Please report it privately through GitHub's *Security → Report a vulnerability* rather than a public issue.

## Limitations

- **One container instance.** Fine for hundreds of domains' worth of reports; not horizontally scaled.
- **No forensic (RUF) reports.** The upstream parser doesn't support them, and large receivers have mostly stopped sending them.
- **Geolocation uses [ip-api.com](https://ip-api.com)**, whose free tier is **non-commercial only** and rate-limited, so new addresses are resolved gradually. For commercial use, get a plan from them or swap the lookup.
- **Sync de-duplication** compares the container's report list against every report already in D1. That is fine for tens of thousands of reports and worth revisiting well beyond that.
- **No alerting or scheduled reports yet** (the daily cron trigger is reserved for it).

## Roadmap

Alerting (new sender, pass-rate drop) to Slack/email/webhook · enforcement rollout tracking over time (`pct=25 → 100 → reject`) · BIMI readiness check · JSON API and CSV export · multi-select domain filter on every page.

## Contributing

Issues and pull requests are welcome. Run `npm run typecheck` before submitting. Schema changes are made by **appending** a migration in `src/migrations.ts`; never edit one that has shipped.

## License

[MIT](LICENSE). Built on [dmarc-report-viewer](https://github.com/cry-inc/dmarc-report-viewer) by cry-inc (MIT), run unmodified. See [NOTICE.md](NOTICE.md) for third-party software and service terms.
