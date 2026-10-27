# Using the dashboard

[← Back to the README](../README.md)

A sidebar holds the navigation and the theme toggle. The top bar carries two **global filters** that apply to every page: a searchable **domain multi-select** and a **time range** (7d, 30d, 90d, 1y, All). The default range is **90 days**. Large tables are searchable, sortable and paginated.

<a href="images/reports.png"><img src="images/reports.png" alt="The DMARC reports list" width="720"></a>

| Page | What it is for |
|---|---|
| **Overview** | Totals, pass/fail trend, volume by sender, sending sources and enforcement readiness, compared with the previous period. |
| **Domains** | One row per domain, riskiest first: tags, policy, status (enforced, ready to tighten, needs attention), volume, pass rate, last report. |
| **Tags** | Put tags on many domains at once, import and export them, and write automatic rules. In the sidebar; always asks for the login. |
| **DMARC reports** | Every report, filterable by DKIM or SPF problems, with per-record detail and the original XML and JSON (view or download). |
| **TLS reports** | SMTP TLS (MTA-STS and DANE) results and failures. |
| **Sender map** | Where your mail is being sent from. |
| **Summary report** | A printable one-document summary for the current filters: key findings, trend, domain status, failing senders, policy changes, TLS. Print it to PDF or download it as HTML. |
| **Admin** | Five tabs down the left side: **Setup status**, **Mailboxes**, **Dashboard visibility**, **Account** (change the admin user name and password) and **Notifications** (webhooks, a collapsible **Alert rules** section, and the digest). Each tab has its own link, such as `/admin#notifications`. Always requires login. |

**Who can see the dashboard.** By default every page requires the admin login. In **Admin** you can switch on *Allow anyone with the link to view the dashboard*, which makes the read-only pages public. Those pages show your sending IPs, senders and pass rates, so decide whether that is acceptable first. `/admin` is never public.

### Filters that follow you everywhere

The domain selector and time range are kept in the URL, so a link shows the same view to whoever opens it.

<img src="images/filters.gif" alt="Selecting two domains and changing the time range" width="700">

## Sync schedule

**Admin → Setup status → Sync schedule** sets how often the mailboxes are checked: every 5, 10, 15 or 30 minutes, or every 1, 2, 4, 6, 12 or 24 hours. The default is 15 minutes. Receiving providers send aggregate reports about once a day, so a short interval mostly finds nothing new; it mainly matters if you want alerts quickly.

The app wakes every 5 minutes and runs a sync only when one is due, so the interval changes without a redeploy or restart. On Cloudflare that wake-up is the cron in `wrangler.jsonc`; self-hosted, the server has its own timer and there is nothing to configure. Every wake-up also checks alerts and the digest, so they are on time whatever the interval. The **Run sync now** button is always available, and counts as a sync for the schedule.

Things that follow from it:
- The parser re-reads the mailbox every 5 to 15 minutes while it runs (matching your interval, capped at 15). Changing the interval restarts the parser once, on the next sync.
- Each sync waits for the parser to finish reading before copying reports, so a parser that has just started (or a Cloudflare container that slept between syncs) is handled. If a mailbox never finishes (wrong login or folder), the sync reports it and the *Sync problem* alert fires, instead of quietly syncing nothing. Self-hosted, a failed first read is reported at once with the reason, and the next sync tries again with a fresh parser.
- On Cloudflare, if you deployed an earlier version, its cron fired every 15 minutes. Intervals shorter than that need `"crons": ["*/5 * * * *"]` in your wrangler config and a redeploy; Admin shows a warning if the deployed schedule is slower than the interval you chose.


## Several mailboxes

If your reports arrive in more than one mailbox (different `rua=` addresses, a separate TLS-RPT address, one per business unit), add them all under **Admin → Mailboxes**. Each has a nickname, host, user, password and folder, and a **Test** button that logs in and opens the folder (it reports a wrong password, a disabled IMAP setting or a missing folder in plain words). **Pause** skips a mailbox without removing it.

Everything is combined: the dashboard, exports, summary report and alerts show one view, sorted by domain, and a report that reaches two mailboxes is stored once. Each report remembers which mailbox it came from.

**How it works depends on where you run it.**

- **Self-hosted (Docker, Kubernetes):** each mailbox gets its **own parser**, running side by side. They are refreshed independently on the sync schedule, there is no taking turns, and original XML/JSON comes straight from that mailbox's parser. Memory grows with each mailbox, so size the container or pod for the total; a mailbox that fails (wrong password, server down) is recorded on its row and never affects the others.
- **Cloudflare:** one parser container reads the mailboxes **in turns**, so the cost stays what it is with a single mailbox. On each sync run it loads a mailbox, waits for the parser to finish reading it, copies the new reports into the database, then moves to the next. If a run is short of time it stops and the next run continues from the mailbox it did not reach, so none is starved. A failing mailbox never stops the others.
  - **More mailboxes means each is refreshed less often**, because the parser has to re-read a folder after every switch. A small mailbox takes about a minute; a very large folder can take several (raise `READ_TIMEOUT_SECONDS`, default 240, if a large one times out). With one mailbox nothing is switched or re-read.
  - **Original XML/JSON** for a report from a mailbox the parser is not holding takes up to a minute to fetch, because it has to switch first. The buttons show progress while it works. The parsed data in the dashboard is always available.
  - If you need mailboxes refreshed more often than this allows, the alternative is one container per mailbox, which costs roughly $1.75 per month more for each.

Up to 10 mailboxes.


## Exports and reports

**Export.** Every table has an **Export** menu with CSV and JSON downloads that match what is on screen: the same domain filter, time range and search.

<a href="images/export-menu.png"><img src="images/export-menu.png" alt="The export menu on the Domains table" width="720"></a>

| Dataset | One row per |
|---|---|
| Domains | domain: tags, policy, status, messages, failing, pass rate, last report |
| Sending sources | source IP: sender, reverse DNS, messages, failing, issues |
| DMARC reports | report: reporter, period, policy, messages, failing |
| Every record | source per report: the raw authentication results |
| TLS results / TLS failures | TLS policy result / failure detail |
| Domain tags | domain: the tags set by hand, and the ones a rule gives it |

CSV files open correctly in Excel and Sheets (UTF-8 with a byte order mark). Text that a spreadsheet could interpret as a formula, such as a sender name starting with `=` or `@`, is prefixed with an apostrophe so it stays text; report data comes from third parties, so this matters. Each export is capped at 100,000 rows; if a file hits the cap the `X-Export-Truncated` header (and a `truncated` field in JSON) says so, and a shorter time range or domain filter gets the rest.

**Summary report.** Open **Summary report** in the sidebar for a clean, light, one-document summary of the current filters. Use **Print / Save as PDF** in your browser, or **Download HTML** for a self-contained file you can email or archive (no scripts, no external requests).

Exports and the summary report **always require the admin login**, even when the dashboard is public, because a bulk export of every source IP is more than page-by-page browsing is meant to hand out. The original report XML and JSON follow the same rule.
