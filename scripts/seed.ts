/**
 * Seeds a demo user ("demo") with past conversations dated relative to NOW, so the
 * three headline questions can be tried immediately:
 *
 *   npm run seed   then open   http://localhost:3000/?u=demo
 *
 *  - most recent Monday : a 5-CRM shortlist
 *  - 9 days ago         : a managed-Postgres pricing answer (3 Nov when today is 12 Nov)
 *
 * The prices in the seeded answers are illustrative stand-ins for "what the agent said
 * back then". The point of the demo is that the agent re-checks them against the live web.
 */
import 'dotenv/config';
import { Ledger } from '../src/ledger.ts';
import { addDays, isValidTz, localYmd, systemTz, weekdayOf, zonedToUtc } from '../src/time.ts';

const tz = isValidTz(process.env.DEFAULT_TZ) ? process.env.DEFAULT_TZ : systemTz();
const now = process.env.NOW_OVERRIDE ? new Date(process.env.NOW_OVERRIDE) : new Date();
const today = localYmd(now, tz);
const path = process.env.LEDGER_PATH || 'data/ledger.jsonl';
const ledger = new Ledger(path);

if (ledger.list('demo').length) {
  console.log('Demo user already seeded. Delete data/ledger.jsonl to reseed.');
  process.exit(0);
}

let monday = addDays(today, -1);
while (weekdayOf(monday) !== 1) monday = addDays(monday, -1);
const pgDay = addDays(today, -9);
const at = (day: string, h: number, m: number) => zonedToUtc(day, h, m, tz).toISOString();
const base = { userId: 'demo', sessionId: 'seed_session', tz };

ledger.add({
  ...base,
  ts: at(monday, 11, 20),
  question: 'We need a CRM for a 20-person sales team, mostly outbound. Shortlist 5 with pricing.',
  answer: [
    'Here is a five-tool shortlist for a 20-person outbound team (prices per user/month, billed annually, as of today):',
    '',
    '| Tool | Plan to look at | Price | Why |',
    '|---|---|---|---|',
    '| Pipedrive | Advanced | ~$34 | Simple pipeline view, good for outbound |',
    '| HubSpot Sales Hub | Professional | ~$90 | Strongest ecosystem; pricey at 20 seats |',
    '| Zoho CRM | Enterprise | ~$40 | Best value, deep customisation |',
    '| Freshsales | Pro | ~$39 | Built-in phone and email, AI lead scoring |',
    '| Close | Growth | ~$99 | Calling and sequences built for inside sales |',
    '',
    'My pick for pure outbound: Close, then Pipedrive if budget matters.',
  ].join('\n'),
  searches: [{ query: 'best CRM small sales team pricing', urls: [] }],
});

ledger.add({
  ...base,
  ts: at(pgDay, 14, 5),
  question: 'Which managed Postgres hosting should I use for a small SaaS? I care about price.',
  answer: [
    'For a small SaaS, the realistic options and what they cost today:',
    '',
    '- **Neon**: serverless Postgres, usage-based; the paid Launch plan starts at roughly $5/month minimum. Scales to zero, branching is great for previews.',
    '- **Supabase**: Pro plan $25/month per project, includes auth and storage on top of Postgres.',
    '- **Render Postgres**: starts around $6/month for the smallest instance; simple, predictable.',
    '- **AWS RDS**: from ~$15/month for a small instance, but you manage more yourself.',
    '',
    'If you only need a database: Neon or Render. If you want a backend platform: Supabase.',
  ].join('\n'),
  searches: [{ query: 'managed postgres hosting pricing', urls: [] }],
});

ledger.add({
  ...base,
  ts: at(pgDay, 14, 40),
  question: 'Thanks. Any good filter coffee places in Indiranagar?',
  answer: 'Blue Tokai and Third Wave are the dependable ones; for something quieter try Dyu Art Cafe.',
  searches: [],
});

console.log(`Seeded 3 turns for user "demo" in ${path}\n  CRM shortlist  : ${monday}\n  Postgres answer: ${pgDay}\nOpen http://localhost:${process.env.PORT ?? 3000}/?u=demo`);
