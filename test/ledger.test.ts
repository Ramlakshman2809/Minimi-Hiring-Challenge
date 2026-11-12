import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, renderRecall } from '../src/ledger.ts';
import { resolveTimeRefs } from '../src/time.ts';

const IST = 'Asia/Kolkata';
const NOW = new Date('2026-11-11T16:22:00Z');

function seeded() {
  const l = new Ledger(null);
  const base = { userId: 'u1', sessionId: 's0', tz: IST, searches: [] as any[] };
  l.add({ ...base, ts: '2026-11-03T08:35:00Z', question: 'Which managed Postgres host should I use for a small SaaS?', answer: 'Neon from $5/mo, Supabase Pro $25/mo, Render $6/mo.' });
  l.add({ ...base, ts: '2026-11-03T09:10:00Z', question: 'Any good pizza near Koramangala?', answer: 'Try Meraki.' });
  l.add({ ...base, ts: '2026-11-09T05:00:00Z', question: 'Shortlist 5 CRM tools for a 20-person sales team', answer: 'HubSpot, Pipedrive, Zoho, Freshsales, Close.' });
  l.add({ ...base, userId: 'someone-else', ts: '2026-11-03T08:00:00Z', question: 'Postgres hosting?', answer: 'private' });
  return l;
}
const refs = (t: string) => resolveTimeRefs(t, NOW, IST);

test('date-first recall: "last Tuesday" ambiguity is resolved by what was actually recorded', () => {
  const text = 'Last Tuesday I asked you about Postgres hosting. Has pricing changed?';
  const r = seeded().recall({ userId: 'u1', text, refs: refs(text) })!;
  assert.equal(r.emptyForDates, false);
  assert.equal(r.turns[0]!.question.includes('Postgres'), true); // topic ranks first
  assert.ok(r.turns.every((t) => t.day === '2026-11-03')); // 10 Nov had nothing
});

test('explicit date recalls everything from that day only', () => {
  const text = 'What did I ask you on 3 November? Is your answer still correct today?';
  const r = seeded().recall({ userId: 'u1', text, refs: refs(text) })!;
  assert.equal(r.turns.length, 2);
  assert.ok(r.turns.every((t) => t.userId === 'u1'));
});

test('users never see each other\'s turns', () => {
  const text = 'what did I ask on 3 November';
  const r = seeded().recall({ userId: 'u2', text, refs: refs(text) })!;
  assert.equal(r.turns.length, 0);
  assert.equal(r.emptyForDates, true);
});

test('date with nothing recorded says so, and offers labelled topical near-misses', () => {
  const text = 'What did I ask you about CRM tools on 5 November?';
  const r = seeded().recall({ userId: 'u1', text, refs: refs(text) })!;
  assert.equal(r.emptyForDates, true);
  assert.match(r.reason, /Nothing is recorded/);
  assert.match(r.reason, /OTHER dates/);
  assert.equal(r.turns[0]!.question.includes('CRM'), true);
});

test('"On Monday we shortlisted…" finds Monday\'s turn', () => {
  const text = 'On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?';
  const r = seeded().recall({ userId: 'u1', text, refs: refs(text) })!;
  assert.equal(r.turns[0]!.day, '2026-11-09');
});

test('no date, no memory cue → nothing recalled (no needless context)', () => {
  const text = 'What is the best Postgres host?';
  assert.equal(seeded().recall({ userId: 'u1', text, refs: refs(text) }), null);
});

test('memory cue without a date falls back to topical matches', () => {
  const text = 'Is the Postgres answer you gave me earlier still right?';
  const r = seeded().recall({ userId: 'u1', text, refs: refs(text) })!;
  assert.ok(r.turns.some((t) => t.question.includes('Postgres')));
});

test('the live session is excluded (already in context)', () => {
  const text = 'what did I ask on 3 November';
  const r = seeded().recall({ userId: 'u1', text, refs: refs(text), excludeSession: 's0' })!;
  assert.equal(r.turns.length, 0);
});

test('persistence: JSONL survives restart and tolerates a torn last line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const p = join(dir, 'l.jsonl');
  const a = new Ledger(p);
  a.add({ userId: 'u1', sessionId: 's', tz: IST, ts: '2026-11-03T08:35:00Z', question: 'q', answer: 'a', searches: [] });
  appendFileSync(p, '{"id":"torn","userId'); // crash mid-write
  const b = new Ledger(p);
  assert.equal(b.size, 1);
  assert.equal(b.list('u1')[0]!.day, '2026-11-03');
  assert.equal(readFileSync(p, 'utf8').split('\n')[0]!.includes('"question":"q"'), true);
});

test('renderRecall carries the date the answer was given and a since-anchor', () => {
  const text = 'what did I ask on 3 November';
  const l = seeded();
  const out = renderRecall(l.recall({ userId: 'u1', text, refs: refs(text) })!, IST);
  assert.match(out, /asked="Tue 3 Nov 2026 14:05"/);
  assert.match(out, /use_since="2026-11-03"/);
  assert.match(out, /YOUR ANSWER AT THE TIME: Neon from \$5\/mo/);
});

test('renderRecall respects its size budget', () => {
  const l = new Ledger(null);
  for (let i = 0; i < 6; i++) {
    l.add({ userId: 'u', sessionId: 's', tz: IST, ts: `2026-11-03T0${i}:00:00Z`, question: 'q' + i, answer: 'x'.repeat(5000), searches: [] });
  }
  const r = l.recall({ userId: 'u', text: 'on 3 November', refs: refs('on 3 November'), max: 6 })!;
  assert.ok(renderRecall(r, IST, 9000).length < 14000);
});

void writeFileSync;
