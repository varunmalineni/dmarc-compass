# Contributing

Issues and pull requests are welcome. For anything larger than a small fix, please open an issue first so the approach can be agreed before you spend time on it.

## Set up

You need Node.js 20 or newer (CI runs 22). Docker is needed only for the end-to-end tests and for running the Cloudflare version locally.

```bash
git clone https://github.com/<you>/dmarc-compass.git
cd dmarc-compass
npm install
```

To explore the interface with no mailbox, load the synthetic [demo data](docs/demo.md).

## Commands

```bash
npm run typecheck   # Worker and Node code
npm test            # unit tests (schedule math, sync, parser pool, settings, escaping, security, deploy files, docs links)
npm run build:node  # bundle the self-hosted server into dist/server.mjs
npm run e2e:docker  # the image with the real parser and a real IMAP server (needs Docker)
npm run e2e:k8s     # the manifests on a real cluster (needs kubectl and a cluster)
npm run bench       # scale benchmark on generated data
npm run vendor      # refresh public/vendor after bumping Chart.js, Leaflet or Inter
```

Before you open a pull request, run `npm run typecheck` and `npm test`. Changes to `deploy/` or to anything the self-hosted image does should also pass `npm run e2e:docker` and `npm run e2e:k8s`; CI runs both on every pull request.

## Conventions

- **Schema changes append a migration** in `src/migrations.ts`. Never edit one that has shipped.
- **One codebase, two hosts.** `src/app.ts` holds the application. The few places that differ between Cloudflare and self-hosting sit behind the interface in `src/runtime.ts`. See [How it works](docs/how-it-works.md).
- **No personal or account-specific values** in the repository: no real domains, addresses, account IDs or credentials. Wrangler keeps account details in `wrangler.local.jsonc`, which is gitignored. Test data uses `.example` domains and documentation-range IP addresses.
- **Tests go with the change.** A new behaviour gets a unit test; a change to what a user sees gets a check in the end-to-end scenario (`scripts/e2e/lib.mjs`) when it can be exercised there.
- **Documentation moves with the code.** If a setting, page or command changes, update the page in `docs/` that describes it. `npm test` checks that links between the documents point at files and headings that exist.
- Test imports use explicit `.ts` extensions in files that unit tests load, because the tests run with Node's built-in TypeScript support.

## Releases

Maintainers cut a release by tagging; the workflow builds, tests and publishes the container image. See [Releasing](docs/releasing.md).

## Reporting a problem

Open an issue and choose the bug report form. Please remove mailbox passwords, webhook URLs and encryption keys from anything you paste. If you think you have found a security problem, do not open an issue; follow [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE) of this project.
