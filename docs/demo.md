# Try it without a mailbox

[← Back to the README](../README.md)

Explore the whole UI locally with synthetic data, with no Cloudflare account or IMAP mailbox. It is 22 invented `.example` domains with realistic sender mixes, a few misconfigured senders, some TLS failures, and a set of tags (including one automatic rule) to try the Tags page and the filter on, and it is how the README screenshots were made.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run dev          # leave running; open http://localhost:8787 once so the tables are created
npm run demo         # in a second terminal: loads the demo data into the local database
```

Reload the page. `npm run demo` only ever writes to the local simulator (it always passes `--local`), never to a deployed database, and it replaces any reports already in the local database. Docker must be running, as for any `wrangler dev` with a container.
