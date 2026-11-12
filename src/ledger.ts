/**
 * The ledger: a dated, append-only record of every turn.
 *
 * Why this exists: "what did I ask you on 3 November — is it still correct?" and
 * "since Monday, has anything changed?" are questions about *the agent's own
 * past*. A model with a context window can't answer them across sessions, and a
 * summarised memory loses exactly the part that matters (the date and the
 * specific claims made, which are what must be re-checked).
 *
 * So we store each turn verbatim with its timestamp, time zone and the searches
 * behind it, and retrieve by *calendar date first* (the resolver in time.ts
 * turns "last Tuesday" into candidate days) and by keyword second. Retrieval is
 * plain code that runs before the model, not a tool: the agent has exactly one
 * tool (web search), and memory costs zero extra model round-trips.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fmtDay, localHm, localYmd, type TimeRef, type Ymd } from './time.ts';

export interface LedgerTurn {
  id: string;
  userId: string;
  sessionId: string;
  ts: string; // ISO instant the question arrived
  tz: string;
  day: Ymd; // calendar day in the user's tz at that moment
  question: string;
  answer: string;
  searches: Array<{ query: string; since?: string; urls: string[] }>;
}

export interface Recall {
  /** Why these turns were selected — shown to the model. */
  reason: string;
  turns: LedgerTurn[];
  /** The user pointed at specific dates and nothing was recorded for them. */
  emptyForDates: boolean;
}

const STOP = new Set(
  'the a an and or but if of to in on at for with from by is are was were be been it its this that these those i you we they my our your me us do did does done what which who how when where why can could should would will has have had not no yes any all some more most than then so as about into over after before since still again last next ago asked ask said tell told please just also like get got answer answers gave right correct earlier changed change update updates anything thing things one ones new'.split(' '),
);

export function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{1,}/g) ?? []).filter((w) => !STOP.has(w));
}

export function overlapScore(query: string, doc: string): number {
  const q = new Set(tokens(query));
  if (!q.size) return 0;
  const d = new Set(tokens(doc));
  let hit = 0;
  for (const w of q) if (d.has(w)) hit++;
  return hit; // raw count of distinctive shared words: one rare topic word ("postgres") is a real signal
}

const MEMORY_CUE =
  /\b(i asked|did i ask|i told you|we (discussed|talked|shortlisted|looked|covered|picked|chose)|you (said|told|recommended|answered|suggested|gave|found)|earlier|previously|last time|since (then|we|you|monday|tuesday|wednesday|thursday|friday)|still (correct|true|right|valid|accurate|hold)|changed since|any updates?|as before|same as|that (list|shortlist|answer|question))\b/i;

export class Ledger {
  private turns: LedgerTurn[] = [];

  constructor(private path: string | null) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          this.turns.push(JSON.parse(line) as LedgerTurn);
        } catch {
          /* a torn last line after a crash must not take the server down */
        }
      }
    } else if (path) {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  get size() {
    return this.turns.length;
  }

  add(t: Omit<LedgerTurn, 'id' | 'day'> & { id?: string }): LedgerTurn {
    const turn: LedgerTurn = {
      ...t,
      id: t.id ?? `t_${Date.parse(t.ts).toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      day: localYmd(new Date(t.ts), t.tz),
      answer: t.answer.slice(0, 6000),
    };
    this.turns.push(turn);
    if (this.path) appendFileSync(this.path, JSON.stringify(turn) + '\n');
    return turn;
  }

  list(userId: string): LedgerTurn[] {
    return this.turns.filter((t) => t.userId === userId);
  }

  /**
   * Find the turns the user is most likely referring to.
   * `refs` come from the deterministic resolver; `excludeSession` is the live
   * conversation, which the model already has in its context.
   */
  recall(opts: {
    userId: string;
    text: string;
    refs: TimeRef[];
    excludeSession?: string;
    max?: number;
  }): Recall | null {
    const max = opts.max ?? 5;
    const mine = this.list(opts.userId).filter((t) => t.sessionId !== opts.excludeSession);
    if (!mine.length) {
      return MEMORY_CUE.test(opts.text) || opts.refs.length
        ? { reason: 'No earlier conversations are recorded for this user.', turns: [], emptyForDates: opts.refs.length > 0 }
        : null;
    }

    const wantedDays = new Set<Ymd>();
    const ranges: Array<{ from: Ymd; to: Ymd }> = [];
    for (const r of opts.refs) {
      r.days.forEach((d) => wantedDays.add(d));
      if (r.range) ranges.push(r.range);
    }
    const dated = wantedDays.size > 0 || ranges.length > 0;
    const inWindow = (t: LedgerTurn) =>
      wantedDays.has(t.day) || ranges.some((r) => t.day >= r.from && t.day <= r.to);

    const rank = (arr: LedgerTurn[]) =>
      [...arr]
        .map((t) => ({ t, s: overlapScore(opts.text, t.question + ' ' + t.answer.slice(0, 600)) }))
        .sort((a, b) => b.s - a.s || Date.parse(b.t.ts) - Date.parse(a.t.ts));

    if (dated) {
      const hits = rank(mine.filter(inWindow));
      if (hits.length) {
        return {
          reason: `Turns recorded on the date(s) the user referred to${wantedDays.size > 1 ? ' (the phrase was ambiguous, so several candidate days are included — say which one you used)' : ''}. Most topically relevant first.`,
          turns: hits.slice(0, max).map((h) => h.t),
          emptyForDates: false,
        };
      }
      // Nothing on those dates. Offer topical near-misses, clearly labelled.
      const near = rank(mine).filter((h) => h.s >= 1).slice(0, 2).map((h) => h.t);
      return {
        reason: 'Nothing is recorded for the dates the user referred to.' + (near.length ? ' The turns below are the closest by topic, from OTHER dates.' : ''),
        turns: near,
        emptyForDates: true,
      };
    }

    if (MEMORY_CUE.test(opts.text)) {
      const best = rank(mine).filter((h) => h.s >= 1).slice(0, 3).map((h) => h.t);
      const recent = mine.slice(-2);
      const merged = [...new Map([...best, ...recent].map((t) => [t.id, t])).values()].sort(
        (a, b) => Date.parse(a.ts) - Date.parse(b.ts),
      );
      return { reason: 'No date was given; these are the best topical matches plus the most recent turns.', turns: merged.slice(-max), emptyForDates: false };
    }
    return null;
  }
}

/** Render recalled turns for the prompt, with a hard size budget. */
export function renderRecall(r: Recall, viewerTz: string, budget = 9000): string {
  const lines: string[] = [`<memory note="${r.reason}">`];
  let used = 0;
  for (const t of r.turns) {
    const when = new Date(t.ts);
    const answer = t.answer.length > 3200 ? t.answer.slice(0, 3200) + ' …[truncated]' : t.answer;
    const block = [
      `<turn id="${t.id}" asked="${fmtDay(localYmd(when, viewerTz))} ${localHm(when, viewerTz)}" use_since="${localYmd(when, viewerTz)}">`,
      `USER: ${t.question}`,
      t.searches.length ? `SEARCHED: ${t.searches.map((s) => s.query).join(' | ')}` : '',
      `YOUR ANSWER AT THE TIME: ${answer}`,
      `</turn>`,
    ]
      .filter(Boolean)
      .join('\n');
    if (used + block.length > budget && used > 0) break;
    used += block.length;
    lines.push(block);
  }
  lines.push('</memory>');
  return lines.join('\n');
}
