# Third-party software and services

dmarc-compass is MIT licensed (see LICENSE). It builds on the following.

## Run as-is, not modified

- **dmarc-report-viewer** by cry-inc, MIT License
  https://github.com/cry-inc/dmarc-report-viewer
  Runs unmodified as the container image defined in `Dockerfile`. It does the
  IMAP fetching and DMARC / SMTP TLS report parsing; dmarc-compass reads its
  JSON API and stores the results in D1. All of that parsing work is theirs.

## Served with the app

These are copied into `public/vendor` (see `npm run vendor`) and served from the
same origin as the dashboard; nothing is loaded from a CDN.

- **Chart.js**, MIT License. https://www.chartjs.org
- **Leaflet**, BSD-2-Clause License. https://leafletjs.com
- **Inter** typeface (via `@fontsource-variable/inter`), SIL Open Font License 1.1.
  https://rsms.me/inter/

Exact versions are listed in `public/vendor/VERSIONS.txt`.

## Loaded in the browser from a third party

- Map tiles are provided by **OpenStreetMap** contributors and are subject to
  the OpenStreetMap tile usage policy. https://operations.osmfoundation.org/policies/tiles/
  This is the only third-party request the dashboard makes, and only on the
  Sender map page.

## External services

- **ip-api.com** supplies IP geolocation (through the container's
  `/ips/{ip}/location` endpoint). Its free tier is for **non-commercial use
  only** and is rate-limited to 45 requests per minute. If you use
  dmarc-compass commercially, arrange a paid plan with them or replace the
  lookup. See https://ip-api.com/docs/legal
