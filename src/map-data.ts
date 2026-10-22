import { domainFilter, sinceEpoch, type Filters } from "./filters";

const MAX_POINTS = 1500;

export interface MapPoint {
  ip: string;
  lat: number;
  lon: number;
  city: string;
  country: string;
  esp: string;
  total: number;
  passed: number;
}

export async function loadMapPoints(
  db: D1Database,
  f: Filters,
): Promise<{ points: MapPoint[]; unresolved: number }> {
  const since = sinceEpoch(f.range);
  const dc = domainFilter("r.domain", f);

  const [points, unresolved] = await Promise.all([
    db
      .prepare(
        `SELECT r.source_ip AS ip, e.lat, e.lon, e.city, e.country, COALESCE(e.esp_name, 'Unknown') AS esp,
                SUM(r.count) AS total,
                SUM(CASE WHEN r.policy_dkim = 'pass' OR r.policy_spf = 'pass' THEN r.count ELSE 0 END) AS passed
           FROM dmarc_records r JOIN ip_enrichment e ON e.ip = r.source_ip
          WHERE e.lat IS NOT NULL AND r.date_begin >= ?${dc.sql}
          GROUP BY r.source_ip ORDER BY total DESC LIMIT ${MAX_POINTS}`,
      )
      .bind(since, ...dc.params)
      .all<{ ip: string; lat: number; lon: number; city: string; country: string; esp: string; total: number; passed: number }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT r.source_ip) AS n
           FROM dmarc_records r LEFT JOIN ip_enrichment e ON e.ip = r.source_ip
          WHERE (e.lat IS NULL) AND r.date_begin >= ?${dc.sql}`,
      )
      .bind(since, ...dc.params)
      .first<{ n: number }>(),
  ]);

  return {
    points: points.results.map((p) => ({
      ip: p.ip,
      lat: p.lat,
      lon: p.lon,
      city: p.city ?? "",
      country: p.country ?? "",
      esp: p.esp,
      total: p.total,
      passed: p.passed,
    })),
    unresolved: unresolved?.n ?? 0,
  };
}
