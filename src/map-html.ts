import type { MapPoint } from "./map-data";
import { rangeLabel, type Filters } from "./filters";
import { escapeHtml, fmtNumber, fmtPct, emptyState, panel, safeJson } from "./shared-ui";

export function renderMapBody(
  data: { points: MapPoint[]; unresolved: number },
  f: Filters,
): { body: string; scripts: string } {
  const { points, unresolved } = data;
  const byCountry = new Map<string, { total: number; passed: number; ips: number }>();
  for (const p of points) {
    const k = p.country || "Unknown";
    const c = byCountry.get(k) ?? { total: 0, passed: 0, ips: 0 };
    c.total += p.total;
    c.passed += p.passed;
    c.ips += 1;
    byCountry.set(k, c);
  }
  const countries = [...byCountry.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 12);

  const note = unresolved
    ? `<div class="note">${fmtNumber(unresolved)} sending IP${unresolved === 1 ? " has" : "s have"} not been located yet. Lookups run a few at a time on each sync (the free geolocation API is rate-limited), so the map fills in over the next few syncs.</div>`
    : "";

  const mapPanel = panel(
    "Where your mail is sent from",
    points.length
      ? `${note}<div id="map" role="img" aria-label="Map of sending sources"></div>
         <p class="hint" style="margin:10px 0 0">Circle size is message volume. Colour is pass rate: green passing, amber partial, red failing.</p>`
      : emptyState("Nothing to plot yet", unresolved ? "Sending IPs are still being located. Check back after the next sync." : "No geolocated sources in this range."),
    { sub: `${escapeHtml(rangeLabel(f.range))} &middot; ${fmtNumber(points.length)} located` },
  );

  const countryPanel = panel(
    "By country",
    countries.length
      ? `<ul class="list">${countries
          .map(([name, c]) => {
            const rate = c.total ? (c.passed / c.total) * 100 : 0;
            return `<li><span><span class="esp">${escapeHtml(name)}</span> <span class="muted small">${c.ips} IP${c.ips === 1 ? "" : "s"}</span></span><span><strong>${fmtNumber(c.total)}</strong> <span class="badge ${rate >= 99.9 ? "good" : rate >= 90 ? "warn" : "bad"}">${fmtPct(rate, 0)}</span></span></li>`;
          })
          .join("")}</ul>`
      : emptyState("No data", "Located sources will be grouped by country."),
  );

  const body = `<div class="grid-main" style="grid-template-columns:minmax(0,2.2fr) minmax(280px,1fr)">${mapPanel}${countryPanel}</div>`;

  const scripts = points.length
    ? `
  var P=${safeJson(
    points.map((p) => ({ lat: p.lat, lon: p.lon, ip: p.ip, esp: p.esp, city: p.city, country: p.country, total: p.total, rate: p.total ? (p.passed / p.total) * 100 : 0 })),
  )};
  var map=L.map('map',{scrollWheelZoom:false}).setView([20,0],2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'&copy; OpenStreetMap contributors',maxZoom:18}).addTo(map);
  var group=[];
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  P.forEach(function(p){
    var color=p.rate>=99.9?'#22c55e':p.rate>=90?'#f59e0b':'#ef4444';
    var m=L.circleMarker([p.lat,p.lon],{radius:Math.max(6,Math.min(26,Math.sqrt(p.total)*3)),color:color,fillColor:color,fillOpacity:0.45,weight:1.5})
      .bindPopup('<strong>'+esc(p.esp)+'</strong><br>'+esc(p.ip)+'<br>'+esc(p.city)+(p.city?', ':'')+esc(p.country)+'<br>'+p.total+' messages &middot; '+p.rate.toFixed(1)+'% pass').addTo(map);
    group.push(m);
  });
  if(group.length>1)map.fitBounds(L.featureGroup(group).getBounds().pad(0.2));
  map.on('click',function(){map.scrollWheelZoom.enable()});`
    : "";

  return { body, scripts };
}
