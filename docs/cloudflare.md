# Run dmarc-compass on Cloudflare

[← Back to the README](../README.md)

**You need:** a Cloudflare account on the **Workers Paid** plan, **Docker** running locally, **Node.js 20+**, and a mailbox with **IMAP** that receives your `rua=` reports.

```bash
git clone https://github.com/varunmalineni/dmarc-compass.git
cd dmarc-compass
npm install
npm run setup
```

`npm run setup` logs you into Cloudflare if needed, deploys the Worker (Wrangler creates the D1 database for you), sets the admin login, and generates the encryption key. Press Enter at the password prompt and a strong one is generated and shown once. `--dry-run` shows what it would do without changing anything.

Then open `https://<your-worker>.workers.dev/admin`, sign in, enter your mailbox, and click **Run sync now**. The first sync takes about a minute while the container starts; after that it syncs every 15 minutes, or on whatever schedule you choose under **Admin → Setup status → Sync schedule**.

Nothing in the repository is specific to your account. Wrangler finds your D1 database by its name, `dmarc-compass`, and creates it on the first deploy. `wrangler.local.jsonc`, a gitignored copy of the config, is what gets deployed. `npm run setup` is safe to run again: it redeploys, keeps the existing encryption key, and does not create a second database.

<details>
<summary><b>Cloudflare cost</b></summary>

<br>

Containers are not available on the free plan. Budget roughly **$6 to $7 per month**: the $5 plan fee plus about $1.75 of container memory and disk beyond the included allowance. With the default 15-minute sync the container stays awake continuously. A longer interval can let it sleep between syncs, but how much that saves has not been measured. See [current Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/).

</details>


## Day-to-day

```bash
npm run deploy      # ship changes; also upgrades the database schema on first request
npm run dev         # local development (copy .dev.vars.example to .dev.vars first)
npm run tail        # live logs
```

Update with `git pull && npm install && npm run deploy`.

## Uninstall

```bash
npx wrangler delete -c wrangler.local.jsonc      # the Worker
npx wrangler containers list                      # find the id of dmarc-compass-dmarcviewercontainer
npx wrangler containers delete <id>
npx wrangler d1 delete dmarc-compass              # the database, and with it all stored reports
```

If you changed the Worker name in `wrangler.local.jsonc`, use that name in place of `dmarc-compass`.


More commands for every platform, and what to do when the dashboard is empty, are in [Operating it](operating.md).
