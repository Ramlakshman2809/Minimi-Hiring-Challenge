import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, describeNow, localYmd, resolveTimeRefs, startOfWeek, zonedToUtc } from '../src/time.ts';

const IST = 'Asia/Kolkata';
// Wed 11 Nov 2026, 21:52 IST (the moment this brief was written)
const WED = new Date('2026-11-11T16:22:00Z');
// Thu 12 Nov 2026, 09:02 IST
const THU = new Date('2026-11-12T03:32:00Z');

const one = (text: string, now = WED, tz = IST) => resolveTimeRefs(text, now, tz);

test('time zone decides the calendar day', () => {
  const lateUtc = new Date('2026-11-11T19:00:00Z'); // 00:30 IST on the 12th, still the 11th in UTC
  assert.equal(localYmd(lateUtc, 'UTC'), '2026-11-11');
  assert.equal(localYmd(lateUtc, IST), '2026-11-12');
  assert.match(describeNow(lateUtc, IST), /^Thursday 12 November 2026, 00:30/);
});

test('zonedToUtc round-trips', () => {
  assert.equal(zonedToUtc('2026-11-03', 14, 5, IST).toISOString(), '2026-11-03T08:35:00.000Z');
  assert.equal(zonedToUtc('2026-07-01', 9, 0, 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
});

test('calendar helpers', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(startOfWeek('2026-11-11'), '2026-11-09'); // Monday
  assert.equal(startOfWeek('2026-11-15'), '2026-11-09'); // Sunday belongs to the week that began Monday
});

test('"Monday" on a Wednesday is the most recent Monday', () => {
  const [r] = one('On Monday we shortlisted 5 CRM tools');
  assert.deepEqual(r!.days, ['2026-11-09']);
  assert.equal(r!.upcoming, '2026-11-16');
  assert.equal(r!.ambiguous, false);
});

test('"last Tuesday" is ambiguous in English: both readings are returned', () => {
  const [r] = one('Last Tuesday I asked you about Postgres hosting');
  assert.deepEqual(r!.days, ['2026-11-10', '2026-11-03']);
  assert.equal(r!.ambiguous, true);
});

test('"last Tuesday" is unambiguous when both readings coincide', () => {
  // Sunday 15 Nov: most recent Tue = 10th; Tuesday of last calendar week = 3rd. Still two.
  // Monday 9 Nov: most recent Tue = 3rd; last calendar week's Tue = 3rd. One.
  const mon = new Date('2026-11-09T05:00:00Z');
  const [r] = one('last Tuesday', mon);
  assert.deepEqual(r!.days, ['2026-11-03']);
  assert.equal(r!.ambiguous, false);
});

test('weekday named today yields today and a week ago', () => {
  const [r] = one('on Wednesday', WED);
  assert.deepEqual(r!.days, ['2026-11-11', '2026-11-04']);
});

test('explicit dates: day-month, month-day, ISO, with and without year', () => {
  assert.deepEqual(one('What did I ask you on 3 November?')[0]!.days, ['2026-11-03']);
  assert.deepEqual(one('on Nov 3rd')[0]!.days, ['2026-11-03']);
  assert.deepEqual(one('on 2026-11-03')[0]!.days, ['2026-11-03']);
  assert.deepEqual(one('3rd of November 2025')[0]!.days, ['2025-11-03']);
  // a date that hasn't happened yet this year means last year's
  assert.deepEqual(one('on 20 December')[0]!.days, ['2025-12-20']);
});

test('"Nov 2026" is a month and year, not "Nov 20" + "26"', () => {
  const refs = one('pricing in Nov 2026');
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0]!.range, { from: '2026-11-01', to: '2026-11-30' });
});

test('relative spans and offsets', () => {
  assert.deepEqual(one('yesterday')[0]!.days, ['2026-11-10']);
  assert.deepEqual(one('2 days ago')[0]!.days, ['2026-11-09']);
  assert.deepEqual(one('last week')[0]!.range, { from: '2026-11-02', to: '2026-11-08' });
  assert.deepEqual(one('last month')[0]!.range, { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(one('a week ago')[0]!.days, ['2026-11-04']);
});

test('January rolls back a year for "last month"', () => {
  const jan = new Date('2027-01-14T10:00:00Z');
  assert.deepEqual(one('last month', jan, 'UTC')[0]!.range, { from: '2026-12-01', to: '2026-12-31' });
});

test('"next Friday" / "this Friday" / "coming Friday"', () => {
  assert.deepEqual(one('this Friday')[0]!.days, ['2026-11-13']);
  assert.deepEqual(one('next Friday')[0]!.days, ['2026-11-20']);
  assert.deepEqual(one('coming Friday')[0]!.days, ['2026-11-13']);
});

test('the verb "may" is not the month; "Sat" alone is not a day', () => {
  assert.equal(one('this may help with pricing').length, 0);
  assert.equal(one('I sat down and read it').length, 0);
  assert.deepEqual(one('back in May')[0]!.range, { from: '2026-05-01', to: '2026-05-31' });
});

test('no dates → no refs', () => {
  assert.deepEqual(one('What is the best Postgres host?'), []);
});

test('local midnight boundary shifts "yesterday"', () => {
  const lateUtc = new Date('2026-11-11T19:00:00Z'); // already Thursday in IST
  assert.deepEqual(one('yesterday', lateUtc, IST)[0]!.days, ['2026-11-11']);
  assert.deepEqual(one('yesterday', lateUtc, 'UTC')[0]!.days, ['2026-11-10']);
});

test('multiple refs in one message keep their order', () => {
  const refs = one('Compare what I asked on 3 November with yesterday');
  assert.deepEqual(refs.map((r) => r.days[0]), ['2026-11-03', '2026-11-10']);
});

test('Thursday: "last Tuesday" still resolves to 10th or 3rd', () => {
  assert.deepEqual(one('last Tuesday', THU)[0]!.days, ['2026-11-10', '2026-11-03']);
});
