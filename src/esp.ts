/**
 * ESP (Email Service Provider) name lookup, matched against reverse-DNS
 * (PTR) hostnames. Covers the common mail providers and transactional
 * senders; extend the list below as you meet new ones. Anything unmatched
 * falls back to showing the raw PTR hostname.
 */
const ESP_PATTERNS: Array<[RegExp, string]> = [
  [/amazonses\.com$/i, "Amazon SES"],
  [/\.zoho\.com$/i, "Zoho Mail"],
  [/google\.com$|googlemail\.com$|_spf\.google\.com$/i, "Google Workspace"],
  [/protection\.outlook\.com$|outlook\.com$/i, "Microsoft 365 / Outlook"],
  [/secureserver\.net$/i, "GoDaddy"],
  [/sendgrid\.net$/i, "SendGrid"],
  [/mailgun\.org$/i, "Mailgun"],
  [/mailchimp\.com$|mandrillapp\.com$/i, "Mailchimp / Mandrill"],
  [/sparkpostmail\.com$/i, "SparkPost"],
  [/pphosted\.com$/i, "Proofpoint"],
  [/mimecast\.com$/i, "Mimecast"],
  [/salesforce\.com$|exacttarget\.com$/i, "Salesforce Marketing Cloud"],
  [/\.yahoodns\.net$/i, "Yahoo"],
  [/icloud\.com$/i, "iCloud Mail"],
];

export function espNameFromPtr(ptr: string | null | undefined): string {
  if (!ptr) return "Unknown";
  for (const [pattern, name] of ESP_PATTERNS) {
    if (pattern.test(ptr)) return name;
  }
  return ptr; // show the raw PTR hostname when we don't recognize it
}
