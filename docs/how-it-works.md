# How it works

[← Back to the README](../README.md)

<details>
<summary><b>Architecture</b></summary>

<br>

```
 receivers (Google, Microsoft, ...)         your domains' rua= address
            │  daily XML reports                      │
            └────────────────► IMAP mailbox(es) ◄─────┘
                                      │
                    ┌─────────────────▼──────────────────┐
                    │  Container: dmarc-report-viewer     │   parses mail + reports
                    │  (upstream project, unmodified)     │   (in memory, JSON API)
                    └─────────────────▲──────────────────┘
                                      │ every sync interval
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

A report is identified by reporter + report ID + domain, enforced by a unique index. The container's own per-report hash changes whenever its mailbox settings change, so it is deliberately not used to decide whether a report has been seen.

</details>

<details>
<summary><b>Architecture (self-hosted)</b></summary>

<br>

```
  receivers ──► IMAP mailbox(es)
                      │
   ┌──────────── one container (or pod) ─────────────────────────┐
   │  parser, unmodified upstream program   × one per mailbox     │
   │  (child processes, listening only on 127.0.0.1)              │
   │              ▲                                               │
   │              │ every sync interval                           │
   │  app (Node)  │  • sync job   → writes to SQLite              │
   │              ▼  • dashboard  → reads from SQLite             │
   │                 • /admin     → settings, status              │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
                 /data volume: dmarc-compass.db (the durable copy)
```

It is the same application code. `src/app.ts` holds everything except the places that differ, which sit behind the small interface in `src/runtime.ts`: `src/cloudflare-host.ts` supplies the Cloudflare version (one shared container, D1, Workers sockets) and `src/node/` the self-hosted one (a parser process per mailbox, SQLite through a D1-shaped adapter, Node sockets). The parser holds its mailbox in memory and forgets it on restart; the database is what survives.

</details>
