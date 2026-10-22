// Mirrors the JSON shape produced by cry-inc/dmarc-report-viewer's Rust
// `Report` struct (src/dmarc.rs) - see /dmarc-reports/{hash}/json.

export interface ReportHeader {
  hash: string;
  id: string;
  org: string;
  domain: string;
  date_begin: number;
  date_end: number;
  records: number;
  flagged_dkim: boolean;
  flagged_spf: boolean;
  flagged_dmarc: boolean;
  flagged: boolean;
}

export interface DmarcReportJson {
  version?: string | null;
  report_metadata: {
    org_name: string;
    email: string;
    report_id: string;
    date_range: { begin: number; end: number };
  };
  policy_published: {
    domain: string;
    p: "none" | "quarantine" | "reject";
    sp?: "none" | "quarantine" | "reject" | null;
    pct?: number | null;
  };
  record: Array<{
    row: {
      source_ip: string;
      count: number;
      policy_evaluated: {
        disposition: "none" | "quarantine" | "reject";
        dkim?: "pass" | "fail" | null;
        spf?: "pass" | "fail" | null;
      };
    };
    identifiers: {
      header_from: string;
    };
    auth_results: {
      dkim?: Array<{ domain: string; selector?: string | null; result: string }> | null;
      spf: Array<{ domain: string; scope?: string | null; result: string }>;
    };
  }>;
}
