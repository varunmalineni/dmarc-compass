# dmarc-compass on Kubernetes

Plain manifests, applied with `kubectl apply -k` (Kustomize is built into kubectl). One pod runs the
app and, as child processes, one parser per mailbox. The database is a SQLite file on a persistent
volume.

What you get: a `Deployment` (one replica), a `PersistentVolumeClaim`, a `Service`, and a
`ConfigMap` generated from `config.env`, all in the `dmarc-compass` namespace. The pod meets the
"restricted" Pod Security profile: non-root, no extra privileges, read-only root filesystem.
An example `Ingress` is in `ingress.example.yaml`.

## Install

1. **Choose the image** and point the manifests at it, by editing the `images:` block at the end of `deploy/kubernetes/kustomization.yaml`.

   **Use the published image** (x86-64 and ARM64; see [the tags](../../docs/self-hosting.md#the-published-image)). Nothing to build:

   ```yaml
   images:
     - name: dmarc-compass
       newName: ghcr.io/<owner>/dmarc-compass
       newTag: "0.1.0"
   ```

   **Or build your own** and push it to a registry your cluster can pull from. (Docker Desktop, OrbStack and minikube with its Docker can use a local image as is.)

   ```sh
   docker build -f deploy/docker/Dockerfile -t registry.example.com/dmarc-compass:1.0 .
   docker push registry.example.com/dmarc-compass:1.0
   ```

   ```yaml
   images:
     - name: dmarc-compass
       newName: registry.example.com/dmarc-compass
       newTag: "1.0"
   ```

2. **Create the namespace and the secret.** The pod will not start without it.

   ```sh
   kubectl apply -f deploy/kubernetes/namespace.yaml
   kubectl -n dmarc-compass create secret generic dmarc-compass-secrets \
     --from-literal=ADMIN_USER=admin \
     --from-literal=ADMIN_PASSWORD='choose-a-long-password' \
     --from-literal=CONFIG_ENCRYPTION_KEY="$(openssl rand -base64 32)"
   ```

   The password needs at least 10 characters. `CONFIG_ENCRYPTION_KEY` encrypts the mailbox passwords stored
   in the database: **keep a copy**, because without it they cannot be read. A Slack webhook can be added
   to the same secret as `SLACK_WEBHOOK_URL=...` or in the Admin page later.

3. **Apply.**

   ```sh
   kubectl apply -k deploy/kubernetes
   kubectl -n dmarc-compass rollout status deployment/dmarc-compass
   ```

4. **Open it.** For a first look:

   ```sh
   kubectl -n dmarc-compass port-forward service/dmarc-compass 8080:80
   ```

   then <http://localhost:8080>. Sign in, open **Admin → Mailboxes**, add your mailbox and click **Run sync now**.

## HTTPS and an Ingress

Signing in needs HTTPS (except on `localhost`). Copy `ingress.example.yaml`, set your host, ingress class and
TLS secret (cert-manager works well), and apply it. Then in `config.env` set

```
TRUST_PROXY=true
PUBLIC_URL=https://dmarc.example.com
```

and `kubectl apply -k deploy/kubernetes` again; the pod restarts with the new settings. `TRUST_PROXY=true` makes
the sign-in lockout use the client address your ingress passes in `X-Forwarded-For`; only set it when traffic
really comes through a proxy you control, or a client could pick its own address.

## Changing the admin password

Sign in, open **Admin → Account**, and change the user name or password. The new one is stored hashed in the database (on the volume), and the Secret's `ADMIN_USER` and `ADMIN_PASSWORD` only matter on a fresh install after that. If you forget it:

```sh
kubectl -n dmarc-compass exec deploy/dmarc-compass -- node dist/server.mjs --reset-admin
```

## Things to know

- **One replica only.** The database is a SQLite file and a sync takes a lock, so more replicas would not share
  the work, they would fight. The `Recreate` strategy stops the old pod before the new one starts, so an
  upgrade has a short gap instead of two pods on one volume.
- **Storage** must be block storage (`ReadWriteOnce`). Do not put the database on NFS or another network file
  system: SQLite depends on file locks those do not reliably provide. Set `storageClassName` in `pvc.yaml` if
  your cluster has no default class.
- **Memory.** Each parser holds its mailbox in memory. The pod is limited to 1 GiB; raise `limits.memory` in
  `deployment.yaml` for large mailboxes or many of them. A pod killed for memory shows `OOMKilled` in
  `kubectl describe pod`.
- **Network.** The pod needs outbound access to your mail server (IMAP over TLS, port 993) and to a DNS server for
  reverse lookups of sending IPs. If your cluster blocks public DNS, set `DNS_SERVER` in `config.env` to one it allows.
- **Backups.** Make a consistent copy while it runs, and keep it together with `CONFIG_ENCRYPTION_KEY`:

  ```sh
  kubectl -n dmarc-compass exec deploy/dmarc-compass -- node dist/server.mjs --backup /data/backup.db
  kubectl -n dmarc-compass cp dmarc-compass/$(kubectl -n dmarc-compass get pod -l app.kubernetes.io/name=dmarc-compass -o name | cut -d/ -f2):/data/backup.db ./backup.db
  ```

  (`kubectl cp` needs `tar` in the container, which the image has.) To restore, scale to zero, put the file back
  as `dmarc-compass.db` on the volume (delete `-wal` and `-shm` beside it) and scale back to one. Volume snapshots
  also work if your storage supports them.
- **Upgrading.** Change `newTag` in `kustomization.yaml` to the new release (or build and push a new tag of your own), and run `kubectl apply -k deploy/kubernetes`. Tables are upgraded
  automatically when the new pod starts, and the volume is kept.
- **Troubleshooting.** `CreateContainerConfigError` means the secret is missing. If the pod restarts in a loop, run
  `kubectl -n dmarc-compass logs deploy/dmarc-compass`: a missing or too-short setting is named there.

## Testing these manifests

`npm run e2e:k8s` applies them to the cluster your `kubectl` points at, adds a throwaway IMAP server, and runs the
same checks as the Docker test through a port-forward, plus: the manifests are admitted under the restricted
profile, the filesystem is read-only, and a replaced pod keeps its data. It uses `deploy/kubernetes-e2e`, which
contains a fixed test password and must never be used for a real install.
