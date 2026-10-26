// Taking turns over several mailboxes with one container. All side effects are
// injected, so the scheduling, fairness and failure handling can be unit-tested
// with plain Node and fakes. mailbox-store.ts and index.ts supply the real ones.
//
// One run: for each enabled mailbox, starting where the previous run stopped,
// load it into the container (only if it is not already loaded), wait until the
// parser has finished reading it, then copy its new reports into the database.
// A mailbox that fails never stops the others. A run stops early when its time
// budget is spent, and the next run continues from the first mailbox it did
// not get to.

export interface RotationMailbox {
  id: string;
  name: string;
}

export type LoadResult = { ok: true } | { ok: false; error: string };

export interface RotationDeps<M extends RotationMailbox> {
  now(): number;
  /** Makes the container read this mailbox and waits for the first read to finish. */
  load(m: M): Promise<LoadResult>;
  /** Copies the loaded mailbox's reports into the database. */
  sync(m: M): Promise<{ newReports: number; newTlsReports: number; backlog?: boolean }>;
  /** Records the outcome for the admin page. */
  record(m: M, outcome: { ok: boolean; at: number; detail: string }): Promise<void>;
}

export interface MailboxOutcome {
  id: string;
  name: string;
  ok: boolean;
  newReports: number;
  newTlsReports: number;
  /** More of this mailbox is waiting to be copied: sync again without waiting for the interval. */
  backlog?: boolean;
  error?: string;
}

export interface RotationResult {
  outcomes: MailboxOutcome[];
  /** Index to start from on the next run. */
  nextCursor: number;
  /** True when the budget ran out before every mailbox had a turn. */
  partial: boolean;
}

/** Mailboxes in the order this run should visit them: starting at `cursor`,
 * wrapping around. */
export function turnOrder<M>(list: M[], cursor: number): M[] {
  if (list.length === 0) return [];
  const start = ((cursor % list.length) + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

export async function runRotation<M extends RotationMailbox>(
  list: M[],
  cursor: number,
  deps: RotationDeps<M>,
  opts: { budgetMs: number; minPerMailboxMs: number },
): Promise<RotationResult> {
  const started = deps.now();
  const order = turnOrder(list, cursor);
  const outcomes: MailboxOutcome[] = [];
  let done = 0;

  for (const m of order) {
    // Not enough time left to give this mailbox a fair turn: leave it for the next run.
    // (The first mailbox always gets a turn, so a run always makes progress.)
    if (done > 0 && deps.now() - started + opts.minPerMailboxMs > opts.budgetMs) break;

    let outcome: MailboxOutcome;
    try {
      const loaded = await deps.load(m);
      if (!loaded.ok) {
        outcome = { id: m.id, name: m.name, ok: false, newReports: 0, newTlsReports: 0, error: loaded.error };
      } else {
        const r = await deps.sync(m);
        outcome = { id: m.id, name: m.name, ok: true, newReports: r.newReports, newTlsReports: r.newTlsReports, backlog: !!r.backlog };
      }
    } catch (err) {
      outcome = {
        id: m.id,
        name: m.name,
        ok: false,
        newReports: 0,
        newTlsReports: 0,
        error: String(err instanceof Error ? err.message : err).slice(0, 200),
      };
    }

    outcomes.push(outcome);
    try {
      await deps.record(m, {
        ok: outcome.ok,
        at: Math.floor(deps.now() / 1000),
        detail: outcome.ok ? `${outcome.newReports} new DMARC reports, ${outcome.newTlsReports} new TLS reports` : (outcome.error ?? "failed"),
      });
    } catch {
      // Recording a result must never abort the run.
    }
    done++;
  }

  const nextCursor = list.length === 0 ? 0 : (((cursor % list.length) + done) % list.length + list.length) % list.length;
  return { outcomes, nextCursor, partial: done < order.length };
}

/** One line for the "last sync" indicator. */
export function summarize(outcomes: MailboxOutcome[], partial: boolean): { ok: boolean; text: string } {
  if (outcomes.length === 0) return { ok: true, text: "no enabled mailboxes" };
  const failed = outcomes.filter((o) => !o.ok);
  const reports = outcomes.reduce((a, o) => a + o.newReports, 0);
  const tls = outcomes.reduce((a, o) => a + o.newTlsReports, 0);
  const base = `${reports} new DMARC reports, ${tls} new TLS reports`;
  if (outcomes.length === 1 && failed.length === 0) return { ok: true, text: base };
  const scope = outcomes.length > 1 ? ` across ${outcomes.length - failed.length} of ${outcomes.length} mailboxes` : "";
  const bad = failed.length ? `; failed: ${failed.map((f) => `${f.name} (${f.error})`).join(", ")}` : "";
  const more = partial ? "; the rest continue on the next run" : outcomes.some((o) => o.backlog) ? "; more history is still being imported" : "";
  return { ok: failed.length === 0, text: (base + scope + bad + more).slice(0, 200) };
}
