# Operating it

[← Back to the README](../README.md)

## Cloudflare

```bash
npm run deploy      # ship changes; also upgrades the database schema on first request
npm run dev         # local development (copy .dev.vars.example to .dev.vars first)
npm run tail        # live logs
```

Update with `git pull && npm install && npm run deploy`. Uninstall with `npx wrangler delete -c wrangler.local.jsonc`, then delete the D1 database and the container application from the Cloudflare dashboard.

## Docker

```bash
docker compose logs -f dmarc-compass                 # live logs, including each parser's
git pull && docker compose pull && docker compose up -d   # update; the data volume is kept
docker compose exec dmarc-compass node dist/server.mjs --backup /data/backup.db    # backup
docker compose down                                   # stop (add -v to also delete the data)
```

## Kubernetes

```bash
kubectl -n dmarc-compass logs deploy/dmarc-compass   # live logs
kubectl apply -k deploy/kubernetes                    # update, after changing the image tag
kubectl delete namespace dmarc-compass               # uninstall; this also deletes the data volume
```

Backups, restore and upgrades in detail are in the [Docker guide](self-hosting.md) and the [Kubernetes guide](../deploy/kubernetes/README.md). Keep your `CONFIG_ENCRYPTION_KEY` with any backup.

## The dashboard is empty

Open **Admin** and read *Setup status*; it names what is missing. If the mailbox looks right but nothing arrives, run `scripts/test-imap.py` to separate a mailbox problem from a deployment problem.
