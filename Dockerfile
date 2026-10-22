# The container that does the IMAP fetching and report parsing is the upstream
# dmarc-report-viewer project (MIT), run unmodified. Wrangler builds this file
# and pushes the result to Cloudflare's registry on `npm run deploy`.
#
# Pinned to a release so deploys are reproducible. Dependabot opens a PR when
# a new version is published; bump it deliberately, not implicitly.
# https://github.com/cry-inc/dmarc-report-viewer
FROM ghcr.io/cry-inc/dmarc-report-viewer:2.6.2
