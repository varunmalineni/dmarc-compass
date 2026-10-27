# Running dmarc-compass yourself with Docker

This is the full guide for Docker, Docker Compose and a plain Linux VM (install Docker and use the Compose file).
For Kubernetes see [deploy/kubernetes](../deploy/kubernetes/README.md). For Cloudflare see the
[Cloudflare guide](cloudflare.md).

The container holds the app and the unmodified upstream parser. The app starts **one parser per mailbox**, side by
side, and keeps its data in a SQLite file in a volume. The dashboards, alerts, sign-in and settings are the same code
as on Cloudflare. You need Docker (Compose v2 for the Compose file). The image is built for x86-64 and ARM64, and is published ready to use (see [The published image](#the-published-image)) or can be built from this repository.

You need three settings to start: an admin user, an admin password (at least 10 characters), and an encryption key.
There is deliberately no default password.

## Docker Compose

```sh
cp .env.example .env              # then edit it
docker compose up -d --build
```

Open <http://localhost:8080>. In `.env` you must set:

| Setting | What it is |
|---|---|
| `ADMIN_USER`, `ADMIN_PASSWORD` | The sign-in. At least 10 characters; there is no default password. |
| `CONFIG_ENCRYPTION_KEY` | Encrypts mailbox passwords in the database. Create one with `openssl rand -base64 32` and keep a copy: without it, saved mailbox passwords cannot be read. |

`docker compose up -d --build` builds the image from this checkout. To use the [published image](#the-published-image) instead, skip the build: set `DMARC_COMPASS_IMAGE` in `.env` and run `docker compose pull && docker compose up -d`.

If one is missing, Compose (or the container, with `docker run`) stops and tells you which. Then sign in, open **Admin → Mailboxes**, add your mailbox and click **Run sync now**, as described in the [README](../README.md#docker).

## The published image

Each release is published to GitHub's container registry as `ghcr.io/<owner>/dmarc-compass`, built for **x86-64 and ARM64**, with build provenance and a software bill of materials attached.

| Tag | What it is | Use it for |
|---|---|---|
| `0.1.0` | That exact release. Never changes. | Anything you rely on. |
| `0.1` | The newest `0.1.x` release. | Getting fixes without a new feature release. |
| `latest` | The newest release. | A first try. |
| `edge` | The newest commit on the main branch, which may not be released. | Testing what is coming. |

For Compose, set the image in `.env`, then pull and start:

```sh
# .env
DMARC_COMPASS_IMAGE=ghcr.io/<owner>/dmarc-compass:0.1.0
```

```sh
docker compose pull && docker compose up -d
```

To **upgrade**, change the tag, and run the same two commands. The data volume is kept, and tables are upgraded automatically when the new version starts.

To pin an image exactly, use its digest: `ghcr.io/<owner>/dmarc-compass@sha256:...`. Each release's page lists it. You can see what a tag points at, and the attached build provenance, with `docker buildx imagetools inspect ghcr.io/<owner>/dmarc-compass:0.1.0`.

Before a release gets its tags, the exact image is tested: the Docker and Kubernetes end-to-end tests run on it, and the ARM64 half is started. If either fails, no tag moves.

## Plain `docker run`

```sh
docker run -d --name dmarc-compass -p 127.0.0.1:8080:8080 -v dmarc-data:/data \
  -e ADMIN_USER=admin -e ADMIN_PASSWORD='choose-a-long-password' \
  -e CONFIG_ENCRYPTION_KEY="$(openssl rand -base64 32)" ghcr.io/<owner>/dmarc-compass:0.1.0
```

To build it yourself instead: `docker build -f deploy/docker/Dockerfile -t dmarc-compass .` and use `dmarc-compass` as the image name.

(Save the key you generate; this one-liner does not show it again.)

## Changing the admin password

Sign in, open **Admin → Account**, and change the user name or password (you are asked for the current password). It is stored hashed in the database, and every other session is signed out. Once you have done this, the saved login takes precedence over `ADMIN_USER` and `ADMIN_PASSWORD` in `.env`, which only matter on a fresh install.

If you forget it, remove the saved login so the one in `.env` works again:

```sh
docker compose exec dmarc-compass node dist/server.mjs --reset-admin
```

## Settings

The three required ones are above. Everything else is optional.

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port inside the container. |
| `DATA_DIR` | `/data` | Where the database is kept. Mount a volume here. |
| `TRUST_PROXY` | off | Set to `true` behind a reverse proxy that adds `X-Forwarded-For` and `X-Forwarded-Proto`. Without it the sign-in lockout counts the connection's own address, which behind a proxy is the proxy. |
| `PUBLIC_URL` | from the request | The address people use, e.g. `https://dmarc.example.com`, if the proxy does not pass the right host. Used in links in alerts. |
| `ALLOW_INSECURE_HTTP` | off | Lets you sign in over plain `http://` from another machine. Anyone on that network can read the password and session, and Admin shows a warning. Not needed for `http://localhost`. |
| `SLACK_WEBHOOK_URL` | none | Can also be added in Admin. |
| `DNS_SERVER` | `1.1.1.1:53` | Used to look up the names of sending IPs. Change it if your network blocks public DNS. |
| `READ_TIMEOUT_SECONDS` | `240` | How long a sync waits for a very large mailbox to be read. |
| `TZ` | `UTC` | Time zone for the parsers' logs. |

## HTTPS

Sign-in needs HTTPS, except on `localhost`. Put a reverse proxy in front, set `TRUST_PROXY=true` in `.env`, and keep the container's port bound to `127.0.0.1` as the Compose file does. With [Caddy](https://caddyserver.com), which gets the certificate for you and passes `X-Forwarded-For` and `X-Forwarded-Proto`, the whole configuration is:

```
dmarc.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

This setup was tried by hand (Caddy in front of the container, `TRUST_PROXY=true`): signing in over HTTPS gives the secure cookie, and the lockout counts the real client even if a client sends its own `X-Forwarded-For`. It is not part of the automated tests. With nginx or Traefik, make sure the proxy sets those two headers. Only turn `TRUST_PROXY` on when traffic really arrives through a proxy you control, because it makes the sign-in lockout believe the address the proxy reports.

For a quick look from another computer on a trusted network you can set `ALLOW_INSECURE_HTTP=true` instead; the password and session then travel unencrypted, and Admin shows a warning.

## Backups

Everything is in one SQLite file in the data volume. A consistent copy can be made while the server runs:

```sh
docker compose exec dmarc-compass node dist/server.mjs --backup /data/backup-$(date +%F).db
docker compose cp dmarc-compass:/data/backup-$(date +%F).db .
```

Keep your `CONFIG_ENCRYPTION_KEY` with the backup: without it the saved mailbox passwords cannot be read. To restore, stop the container, put the file back as `dmarc-compass.db` in the volume (delete any `-wal` and `-shm` files next to it) and start again.

## Upgrading

`git pull`, then `docker compose up -d --build`. Tables are upgraded automatically on start, and the data volume is kept.

## Memory and limits

Each parser holds its mailbox in memory, so memory grows with the number and size of mailboxes. The Compose file caps the container at 1 GB; raise `mem_limit` for large ones. A long query (the year or all-time Overview of a very large fleet) holds up other requests while it runs, which is fine for one admin or a few users.

## How this is tested

 `npm run e2e:docker` and `npm run e2e:k8s` build the image, starts a real IMAP test server (GreenMail), fills a mailbox with synthetic reports and drives the app over HTTP: sign-in, adding the mailbox, syncing through the real parser, exports, restarting, and checking that nothing is lost. The Kubernetes one also replaces the pod and checks the volume keeps the data.

