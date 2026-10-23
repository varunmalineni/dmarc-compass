// The plain-English "key findings" of a summary report. Pure, so it can be
// unit-tested; the wording is deliberately conservative and factual.

export interface FindingsInput {
  scope: string;
  periodLabel: string;
  messages: number;
  passRate: number | null;
  prevPassRate: number | null;
  domains: number;
  enforced: number;
  ready: number;
  attention: number;
  topDomain: { domain: string; failing: number; rate: number } | null;
  topSender: { sender: string; ip: string; failing: number } | null;
  policyChanges: number;
  newSenders: number | null;
  tlsSessions: number;
  tlsFailed: number;
}

const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const num = (n: number) => Math.round(n).toLocaleString("en-US");

export function findings(i: FindingsInput): string[] {
  const out: string[] = [];

  if (i.messages === 0) {
    out.push(`No messages were reported for ${i.scope} in this period (${i.periodLabel.toLowerCase()}). Receivers can take a day or two to report.`);
  } else {
    let line = `${num(i.messages)} messages from ${plural(i.domains, "domain")} were reported, and ${i.passRate!.toFixed(1)}% passed DMARC`;
    if (i.prevPassRate !== null) {
      const d = i.passRate! - i.prevPassRate;
      line += Math.abs(d) < 0.05 ? " (unchanged from the previous period)" : ` (${d > 0 ? "up" : "down"} ${Math.abs(d).toFixed(1)} points from the previous period)`;
    }
    out.push(line + ".");
  }

  if (i.attention > 0) {
    let line = `${plural(i.attention, "domain")} ${i.attention === 1 ? "has" : "have"} failing messages to resolve before the policy is tightened`;
    if (i.topDomain) line += `; the largest is ${i.topDomain.domain} with ${num(i.topDomain.failing)} failing (${i.topDomain.rate.toFixed(1)}% pass)`;
    out.push(line + ".");
  }
  if (i.ready > 0) out.push(`${plural(i.ready, "domain")} had no failing messages and ${i.ready === 1 ? "is" : "are"} ready to move to a stricter policy.`);
  if (i.enforced > 0) out.push(`${plural(i.enforced, "domain")} already ${i.enforced === 1 ? "publishes" : "publish"} p=reject.`);

  if (i.topSender) out.push(`The sender with the most failing messages is ${i.topSender.sender} (${i.topSender.ip}), with ${num(i.topSender.failing)} failing.`);
  if (i.policyChanges > 0) out.push(`${plural(i.policyChanges, "policy change")} ${i.policyChanges === 1 ? "was" : "were"} observed.`);
  if (i.newSenders !== null && i.newSenders > 0) out.push(`${plural(i.newSenders, "new failing sender")} appeared for domains they had not been seen on before.`);
  if (i.tlsFailed > 0) out.push(`${num(i.tlsFailed)} of ${num(i.tlsSessions)} reported TLS sessions failed.`);

  return out;
}
