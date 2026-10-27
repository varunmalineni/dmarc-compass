# Limitations

[← Back to the README](../README.md)

- **One instance, on every platform.** Fine for hundreds of domains' worth of reports; not horizontally scaled. On Cloudflare several mailboxes share one container by taking turns; self-hosted there is one parser per mailbox, but still a single app instance (one replica on Kubernetes, because the database is a SQLite file).
- **Self-hosted specifics.** Backups are yours to schedule. The database must be on local or block storage, not NFS. HTTPS is provided by your reverse proxy or ingress. There is no published container image yet, so you build it from this repository. A long query (the year or all-time Overview of a very large fleet) holds up other requests while it runs.
- **Original XML/JSON comes from the parser**, which re-reads the report's mailbox. If a report email has been deleted or moved out of the configured folder, the parsed data stays in the dashboard but the original file is no longer available.
- **No forensic (RUF) reports.** The upstream parser does not support them, and large receivers have mostly stopped sending them.
- **Geolocation uses [ip-api.com](https://ip-api.com)**, whose free tier is **non-commercial only** and rate-limited, so new addresses are resolved gradually. For commercial use, get a plan from them or swap the lookup.
- **Very late reports.** Each sync checks the last 30 days of reports, and older history is walked in steps once a month, so a report that arrives more than 30 days after its period is picked up at the next monthly pass (see [Scale](scale.md)).
- **Exports are capped at 100,000 rows** each (narrow the time range or domains for more).
- **Alerts cover DMARC and sync health, not TLS failures yet**, and are delivered only to Slack-compatible webhooks (no direct email).
