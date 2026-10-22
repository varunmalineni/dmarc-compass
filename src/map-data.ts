export interface MapPoint {
  ip: string;
  lat: number;
  lon: number;
  city: string;
  country: string;
  countryCode: string;
  espName: string;
  totalCount: number;
  passedCount: number;
}

export async function loadMapPoints(db: D1Database, domainFilter: string | null): Promise<MapPoint[]> {
  const dc = domainFilter ? "AND r.domain = ?" : "";
  const params = domainFilter ? [domainFilter] : [];
  const res = await db
    .prepare(
      `SELECT
         r.source_ip,
         e.lat, e.lon, e.city, e.country, e.country_code,
         COALESCE(e.esp_name, 'Unknown') as esp_name,
         SUM(r.count) as total_count,
         SUM(CASE WHEN r.policy_dkim='pass' OR r.policy_spf='pass' THEN r.count ELSE 0 END) as passed_count
       FROM dmarc_records r
       JOIN ip_enrichment e ON e.ip = r.source_ip
       WHERE e.lat IS NOT NULL ${dc}
       GROUP BY r.source_ip`,
    )
    .bind(...params)
    .all<{
      source_ip: string;
      lat: number;
      lon: number;
      city: string;
      country: string;
      country_code: string;
      esp_name: string;
      total_count: number;
      passed_count: number;
    }>();

  return res.results.map((r) => ({
    ip: r.source_ip,
    lat: r.lat,
    lon: r.lon,
    city: r.city,
    country: r.country,
    countryCode: r.country_code,
    espName: r.esp_name,
    totalCount: r.total_count,
    passedCount: r.passed_count,
  }));
}
