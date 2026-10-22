// Mirrors cry-inc/dmarc-report-viewer's TLS-RPT model (src/tls.rs).

export interface TlsReportHeader {
  hash: string;
  id: string;
  org: string;
  domains: string[];
  date_begin: string; // RFC3339
  date_end: string;
  records: number;
  flagged_sts: boolean;
  flagged_tlsa: boolean;
  flagged: boolean;
}

export interface TlsReportJson {
  organization_name: string;
  date_range: { start_datetime: string; end_datetime: string };
  contact_info?: string | null;
  report_id: string;
  policies: Array<{
    policy: {
      policy_type: "sts" | "tlsa" | "no-policy-found";
      policy_string?: string[] | null;
      policy_domain: string;
      mx_host?: string[] | null;
    };
    summary: { total_successful_session_count: number; total_failure_session_count: number };
    failure_details?: Array<{
      result_type: string;
      sending_mta_ip?: string | null;
      receiving_mx_hostname?: string | null;
      failed_session_count: number;
    }> | null;
  }>;
}
