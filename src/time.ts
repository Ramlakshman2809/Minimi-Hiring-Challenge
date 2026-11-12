/**
 * Deterministic date handling.
 *
 * LLMs are unreliable at weekday arithmetic ("what date was last Tuesday?") and
 * English is genuinely ambiguous about it. So the model never does this: code
 * resolves every relative date in the user's message against the user's clock
 * and time zone, and hands the model concrete calendar dates. Ambiguous phrases
 * resolve to *candidates*; the ledger (memory) then picks between them.
 *
 * All calendar math is done on plain 'YYYY-MM-DD' strings via UTC midnight, so
 * DST and server time zone can never leak in.
 */

export type Ymd = string; // 'YYYY-MM-DD'

const DAY_MS = 86_400_000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

// ---------- primitives ----------

export function isValidTz(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Calendar date of an instant, as seen in `tz`. */
export function localYmd(d: Date, tz: string): Ymd {
  const p = parts(d, tz);
  return toYmd(p.year, p.month, p.day);
}

/** 'HH:MM' of an instant, as seen in `tz`. */
export function localHm(d: Date, tz: string): string {
  const p = parts(d, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Convert a wall-clock time in `tz` to the matching instant. */
export function zonedToUtc(ymd: Ymd, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = fromYmd(ymd);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const offset = (t: number) => {
    const p = parts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - t;
  };
  let t = guess - offset(guess);
  t = guess - offset(t); // second pass handles DST edges
  return new Date(t);
}

export function toYmd(y: number, m: number, d: number): Ymd {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function fromYmd(s: Ymd): [number, number, number] {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function ms(s: Ymd): number {
  const [y, m, d] = fromYmd(s);
  return Date.UTC(y, m - 1, d);
}

export function addDays(s: Ymd, n: number): Ymd {
  const t = new Date(ms(s) + n * DAY_MS);
  return toYmd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

export function diffDays(a: Ymd, b: Ymd): number {
  return Math.round((ms(a) - ms(b)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday */
export function weekdayOf(s: Ymd): number {
  return new Date(ms(s)).getUTCDay();
}

/** Monday of the ISO week containing `s`. */
export function startOfWeek(s: Ymd): Ymd {
  const wd = weekdayOf(s);
  return addDays(s, -((wd + 6) % 7));
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function validYmd(y: number, m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m) && y >= 1970 && y <= 2200;
}

/** 'Mon 9 Nov 2026' */
export function fmtDay(s: Ymd): string {
  const [y, m, d] = fromYmd(s);
  const wd = WEEKDAYS[weekdayOf(s)]!;
  return `${cap(wd).slice(0, 3)} ${d} ${cap(MONTHS[m - 1]!).slice(0, 3)} ${y}`;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function describeNow(now: Date, tz: string): string {
  const day = localYmd(now, tz);
  const [y, m, d] = fromYmd(day);
  const wd = cap(WEEKDAYS[weekdayOf(day)]!);
  return `${wd} ${d} ${cap(MONTHS[m - 1]!)} ${y}, ${localHm(now, tz)} (${tz})`;
}

// ---------- reference resolution ----------

export interface TimeRef {
  /** The phrase as the user wrote it. */
  phrase: string;
  /**
   * Candidate calendar days, most likely first. More than one means the English
   * phrase is genuinely ambiguous. Used for memory lookup.
   */
  days: Ymd[];
  /** For spans ("last week", "in October"): inclusive range. */
  range?: { from: Ymd; to: Ymd };
  /** Human note for the model about how this was resolved. */
  note: string;
  ambiguous: boolean;
  /** Upcoming occurrence for a bare weekday ("Monday" could also mean next Monday). */
  upcoming?: Ymd;
}

const WD_FULL: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const WD_SHORT: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6,
};
const MONTH_IDX: Record<string, number> = {};
MONTHS.forEach((m, i) => {
  MONTH_IDX[m] = i + 1;
  MONTH_IDX[m.slice(0, 3)] = i + 1;
});
MONTH_IDX['sept'] = 9;

const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const WD_RE = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)';
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

interface Hit {
  start: number;
  end: number;
  ref: TimeRef;
}

export function resolveTimeRefs(text: string, now: Date, tz: string): TimeRef[] {
  const today = localYmd(now, tz);
  const lower = text.toLowerCase();
  const hits: Hit[] = [];
  const taken: Array<[number, number]> = [];

  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const add = (m: RegExpExecArray, ref: Omit<TimeRef, 'phrase'>) => {
    const start = m.index;
    // lowercase "may" is almost always the verb ("this may help"), not the month
    if (/\bmay\b/.test(m[0]) && !/\bMay\b/.test(text.slice(m.index, m.index + m[0].length))) return;
    const end = m.index + m[0].length;
    if (overlaps(start, end)) return;
    taken.push([start, end]);
    hits.push({ start, end, ref: { ...ref, phrase: text.slice(start, end).trim() } });
  };
  const each = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      if (m[0].length === 0) re.lastIndex++;
      else fn(m);
    }
  };

  // 1. ISO dates: 2026-11-03
  each(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (m) => {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) return;
    add(m, single(toYmd(y, mo, d), 'explicit date'));
  });

  // 2. "3 November", "3rd of Nov 2025"
  each(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'g'), (m) => {
    const r = explicitDate(Number(m[1]), MONTH_IDX[m[2]!]!, m[3] ? Number(m[3]) : undefined, today);
    if (r) add(m, r);
  });

  // 3. "November 3", "Nov 3rd, 2025"  (digit must not continue: "Nov 2026" is a year, not a day)
  each(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s+(\\d{4})\\b)?`, 'g'), (m) => {
    const r = explicitDate(Number(m[2]), MONTH_IDX[m[1]!]!, m[3] ? Number(m[3]) : undefined, today);
    if (r) add(m, r);
  });

  // 4. Month only, with a preposition: "in October", "last March"
  each(new RegExp(`\\b(in|during|back in|last|this|since|from)\\s+${MONTH_RE}\\b(?:\\s+(\\d{4})\\b)?`, 'g'), (m) => {
    const prep = m[1]!;
    const mo = MONTH_IDX[m[2]!]!;
    const [ty, tm] = fromYmd(today);
    let y = m[3] ? Number(m[3]) : prep === 'this' ? ty : mo > tm ? ty - 1 : ty;
    if (prep === 'last' && !m[3]) y = mo >= tm ? ty - 1 : ty;
    const from = toYmd(y, mo, 1);
    const to = toYmd(y, mo, daysInMonth(y, mo));
    add(m, {
      days: [],
      range: { from, to },
      note: `whole month of ${cap(MONTHS[mo - 1]!)} ${y}`,
      ambiguous: false,
    });
  });

  // 5. "N days/weeks/months ago", "a week ago"
  each(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d{1,3})\s+(day|week|month)s?\s+ago\b/g, (m) => {
    const n = NUM_WORDS[m[1]!] ?? Number(m[1]);
    const unit = m[2]!;
    const center = unit === 'day' ? addDays(today, -n) : unit === 'week' ? addDays(today, -7 * n) : monthsAgo(today, n);
    const slack = unit === 'day' ? (n <= 3 ? 0 : 1) : unit === 'week' ? 2 : 7;
    add(m, {
      days: [center],
      range: slack ? { from: addDays(center, -slack), to: addDays(center, slack) } : undefined,
      note: slack ? `about ${n} ${unit}${n > 1 ? 's' : ''} ago (±${slack} days)` : `${n} day${n > 1 ? 's' : ''} ago`,
      ambiguous: false,
    });
  });

  // 6. Weeks and months as spans
  each(/\b(last|previous|past)\s+week\b/g, (m) => {
    const from = addDays(startOfWeek(today), -7);
    add(m, span(from, addDays(from, 6), 'previous calendar week (Mon–Sun)'));
  });
  each(/\bthis\s+week\b/g, (m) => {
    add(m, span(startOfWeek(today), today, 'current week so far (Mon–today)'));
  });
  each(/\blast\s+month\b/g, (m) => {
    const [y, mo] = fromYmd(today);
    const py = mo === 1 ? y - 1 : y;
    const pm = mo === 1 ? 12 : mo - 1;
    add(m, span(toYmd(py, pm, 1), toYmd(py, pm, daysInMonth(py, pm)), 'previous calendar month'));
  });
  each(/\bthis\s+month\b/g, (m) => {
    const [y, mo] = fromYmd(today);
    add(m, span(toYmd(y, mo, 1), today, 'current month so far'));
  });

  // 7. Weekdays
  //    "last Tuesday" / "previous Tuesday"
  each(new RegExp(`\\b(?:last|previous)\\s+${WD_RE}\\b`, 'g'), (m) => {
    const wd = weekdayIndex(m[1]!);
    const recent = mostRecentPast(today, wd);
    const prevWeek = addDays(addDays(startOfWeek(today), -7), (wd + 6) % 7);
    const days = recent === prevWeek ? [recent] : [recent, prevWeek];
    add(m, {
      days,
      ambiguous: days.length > 1,
      note:
        days.length > 1
          ? `AMBIGUOUS: the most recent ${cap(WEEKDAYS[wd]!)} (${fmtDay(recent)}) or the ${cap(WEEKDAYS[wd]!)} of last calendar week (${fmtDay(prevWeek)})`
          : `most recent ${cap(WEEKDAYS[wd]!)}`,
    });
  });
  //    "this Friday", "coming Friday", "next Friday"
  each(new RegExp(`\\b(this|coming|next)\\s+${WD_RE}\\b`, 'g'), (m) => {
    const wd = weekdayIndex(m[2]!);
    const kind = m[1]!;
    let day: Ymd;
    let note: string;
    if (kind === 'this') {
      day = addDays(startOfWeek(today), (wd + 6) % 7);
      note = 'that weekday in the current calendar week (Mon–Sun)';
    } else if (kind === 'coming') {
      day = nextUpcoming(today, wd);
      note = 'next upcoming';
    } else {
      day = addDays(addDays(startOfWeek(today), 7), (wd + 6) % 7);
      note = 'that weekday in next calendar week';
    }
    add(m, { days: [day], note, ambiguous: false });
  });
  //    bare weekday: full names always; short names ("mon", "sat") only after a cue word
  each(new RegExp(`\\b(?:(on|since|every|from|until|by)\\s+)?${WD_RE}\\b`, 'g'), (m) => {
    const name = m[2]!;
    const cue = m[1];
    if (!(name in WD_FULL) && !cue) return;
    const wd = weekdayIndex(name);
    const past = wd === weekdayOf(today) ? [today, addDays(today, -7)] : [mostRecentPast(today, wd)];
    const upcoming = nextUpcoming(today, wd);
    add(m, {
      days: past,
      upcoming,
      ambiguous: past.length > 1,
      note:
        past.length > 1
          ? `today is a ${cap(WEEKDAYS[wd]!)}: past reading is today or a week ago; upcoming reading is ${fmtDay(upcoming)}`
          : `most recent ${cap(WEEKDAYS[wd]!)} if talking about the past; ${fmtDay(upcoming)} if talking about the future`,
    });
  });

  // 8. Simple days
  each(/\bday before yesterday\b/g, (m) => add(m, single(addDays(today, -2), 'two days ago')));
  each(/\byesterday\b/g, (m) => add(m, single(addDays(today, -1), 'yesterday')));
  each(/\b(today|tonight|this (?:morning|afternoon|evening)|earlier today)\b/g, (m) => add(m, single(today, 'today')));
  each(/\btomorrow\b/g, (m) => add(m, single(addDays(today, 1), 'tomorrow')));

  hits.sort((a, b) => a.start - b.start);
  return hits.map((h) => h.ref);
}

/** Render refs as lines for the prompt (the ledger may later annotate them). */
export function renderRefs(refs: TimeRef[]): string[] {
  return refs.map((r) => {
    const where = r.range
      ? `${fmtDay(r.range.from)} → ${fmtDay(r.range.to)}`
      : r.days.map(fmtDay).join(' or ');
    return `"${r.phrase}" → ${where || '(no date)'} [${r.note}]`;
  });
}

// ---------- helpers ----------

function single(day: Ymd, note: string): Omit<TimeRef, 'phrase'> {
  return { days: [day], note, ambiguous: false };
}

function span(from: Ymd, to: Ymd, note: string): Omit<TimeRef, 'phrase'> {
  return { days: [], range: { from, to }, note, ambiguous: false };
}

function weekdayIndex(name: string): number {
  return WD_FULL[name] ?? WD_SHORT[name]!;
}

/** Most recent given weekday strictly before `today`. */
function mostRecentPast(today: Ymd, wd: number): Ymd {
  const delta = ((weekdayOf(today) - wd + 7) % 7) || 7;
  return addDays(today, -delta);
}

/** Next given weekday strictly after `today`. */
function nextUpcoming(today: Ymd, wd: number): Ymd {
  const delta = ((wd - weekdayOf(today) + 7) % 7) || 7;
  return addDays(today, delta);
}

function monthsAgo(today: Ymd, n: number): Ymd {
  const [y, m, d] = fromYmd(today);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return toYmd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Explicit day+month. With no year, pick the most recent past occurrence. */
function explicitDate(d: number, mo: number, year: number | undefined, today: Ymd): Omit<TimeRef, 'phrase'> | null {
  const [ty] = fromYmd(today);
  if (year !== undefined) {
    return validYmd(year, mo, d) ? single(toYmd(year, mo, d), 'explicit date') : null;
  }
  if (!validYmd(ty, mo, d)) return null;
  const thisYear = toYmd(ty, mo, d);
  if (thisYear <= today) return single(thisYear, 'explicit date');
  const prev = ty - 1;
  if (!validYmd(prev, mo, d)) return null;
  return single(toYmd(prev, mo, d), `no year given; ${thisYear} is in the future, so assuming ${prev}`);
}
