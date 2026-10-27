# Scale

[← Back to the README](../README.md)

These figures come from generated data on a local SQLite database (`npm run bench -- typical|stress`, see `scripts/bench`). The self-hosted versions run on that same SQLite engine, so the timings are closer to what they will see; on Cloudflare, D1 is SQLite too but its milliseconds will differ, and the query plans, query counts and memory are what carry over.

| | Typical | Stress |
|---|---|---|
| Domains | 1,500 | 1,500 |
| History | 90 days | 2 years |
| Reports / records | 126 thousand / 418 thousand | 1.06 million / 3.5 million |
| Database size | 97 MB | 835 MB |

Measured at the stress size:

| | Time |
|---|---|
| Overview, last 7 / 30 / 90 days | 0.2 s / 0.6 s / 1.6 s |
| Reports list (any range) | under 0.03 s |
| Domains, last 90 days / all time | 0.2 s / 0.6 s |
| Map, last 90 days | 0.5 s |
| Exports (capped at 100,000 rows) | under 0.6 s |
| Alerts check, digest | about 0.3 s each |
| Overview, **last year** / **all time** | 7.7 s / 9 s |
| Summary report, last 90 days / **all time** | 2 s / 10 s |

- **Long ranges are the slow part.** Every figure on the Overview comes from adding up the records in the range, so a year or all time of a 1,500-domain fleet reads millions of rows. There are no summary tables for this: with many mail providers reporting the same sending addresses the saving is small (about 1.25 times fewer rows in the test data), so it is not worth the extra code. If you keep years of history and look at long ranges often, open an issue and it can be revisited.
- **Sync** no longer loads the whole report list. It reads it as a stream, checks the last 30 days of reports every sync, and walks older history in steps, remembering where it got to. At 1 million reports it used about 10 MB (the Worker allows 128 MB) and 40 to 80 database calls per sync, against 700 MB and 12,000 calls before. The walk is repeated once a month to catch reports that arrive very late.
- **A big first import is spread over several syncs.** Each sync copies up to 600 new reports, newest first, and syncs again at the next 5-minute wake-up until the backlog is gone. Years of mail for a large fleet therefore fill in over some hours, with the most recent weeks first. The Worker's limits (1,000 database calls and 128 MB per run) are why it is not done at once.
- **The parser is the likely limit on history.** It keeps every report in memory and sends the whole list on each sync, so its memory grows with the mailbox, not with the database. This has not been measured. The database keeps history after mail is deleted, so for very large fleets, archive old report emails out of the mailbox and keep the dashboard history in D1.
- **D1 limits**: 10 GB per database, 30 seconds per query. The stress size is under a tenth of the database limit.
