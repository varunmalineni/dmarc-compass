import type { MapPoint } from "./map-data";
import { escapeHtml, fmtNumber, navHtml, domainSelectorHtml, htmlHead, BRAND } from "./shared-ui";

export function renderMap(points: MapPoint[], allDomains: string[], domainFilter: string | null): string {
  const byCountry = new Map<string, number>();
  for (const p of points) {
    byCountry.set(p.country || "Unknown", (byCountry.get(p.country || "Unknown") ?? 0) + p.totalCount);
  }
  const countryRows = [...byCountry.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([country, count]) => `<tr><td>${escapeHtml(country)}</td><td class="num">${fmtNumber(count)}</td></tr>`)
    .join("");

  const markerData = JSON.stringify(
    points.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      ip: p.ip,
      esp: p.espName,
      city: p.city,
      country: p.country,
      total: p.totalCount,
      passRate: p.totalCount > 0 ? (p.passedCount / p.totalCount) * 100 : 0,
    })),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
${htmlHead(`Sender Map · ${BRAND}`)}
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  .leaflet-popup-content-wrapper { border-radius: 10px; }
  #map { box-shadow: var(--shadow-sm); }
</style>
</head>
<body>
<header>
  <div class="eyebrow">${BRAND}</div>
  <h1>Sender Map</h1>
  ${navHtml("map", domainFilter)}
</header>
<main>
  ${domainSelectorHtml(allDomains, domainFilter, "/map")}
  <div class="card">
    <h2>Sending Sources by Location (${fmtNumber(points.length)} resolved)</h2>
    <p class="form-hint" style="margin-top:-8px;margin-bottom:14px">
      Marker size = message volume, color = pass rate (green = passing, red = failing). Click a
      marker for details. Only IPs that have been geolocated so far are shown - resolution runs
      incrementally (rate-limited to protect the free geolocation API), so this fills in over the
      next few sync cycles.
    </p>
    <div id="map" style="height: 480px; border-radius: 10px;"></div>
  </div>

  <div class="card">
    <h2>By Country</h2>
    <table>
      <thead><tr><th>Country</th><th style="text-align:right">Messages</th></tr></thead>
      <tbody>${countryRows || '<tr><td colspan="2" class="muted">No geolocated sources yet</td></tr>'}</tbody>
    </table>
  </div>
</main>
<script>
  const points = ${markerData};
  const map = L.map('map').setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  for (const p of points) {
    const radius = Math.max(6, Math.min(28, Math.sqrt(p.total) * 3));
    const color = p.passRate >= 99.9 ? '#22c55e' : p.passRate >= 90 ? '#f59e0b' : '#ef4444';
    L.circleMarker([p.lat, p.lon], {
      radius,
      color,
      fillColor: color,
      fillOpacity: 0.45,
      weight: 1.5,
    })
      .bindPopup(
        '<strong>' + p.esp + '</strong><br/>' +
        p.ip + '<br/>' +
        p.city + ', ' + p.country + '<br/>' +
        p.total + ' messages &middot; ' + p.passRate.toFixed(1) + '% pass'
      )
      .addTo(map);
  }
</script>
</body>
</html>`;
}
