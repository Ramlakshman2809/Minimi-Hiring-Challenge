/**
 * Eval harness.
 *
 *   npm run eval            offline: checks the deterministic layer (no API keys, <1s)
 *   npm run eval -- --live  also runs the three headline prompts end to end against the
 *                           real model + real search, against a throwaway ledger, and
 *                           prints latency, searches used and the answer.
 *
 * The offline half is what protects the part that must never be wrong (which date,
 * which past turn). The live half is for reading, not asserting: judge the answers.
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { anthropicLLM, runTurn } from '../src/agent.ts';
import { Ledger } from '../src/ledger.ts';
import { tavilySearch } from '../src/search.ts';
import { addDays, fmtDay, localYmd, renderRefs, resolveTimeRefs, zonedToUtc } from '../src/time.ts';

const tz = process.env.DEFAULT_TZ || 'Asia/Kolkata';
const now = process.env.NOW_OVERRIDE ? new Date(process.env.NOW_OVERRIDE) : new Date();
const today = localYmd(now, tz);
const live = process.argv.includes('--live');

const prompts = [
  'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?',
  'What did I ask you on 3 November? Is your answer still correct today?',
  'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
];

console.log(`\nClock: ${fmtDay(today)} (${tz})\n`);
console.log('── Date resolution ─────────────────────────────');
for (const p of prompts) {
  console.log(`\n"${p.slice(0, 90)}${p.length > 90 ? '…' : ''}"`);
  for (const line of renderRefs(resolveTimeRefs(p, now, tz))) console.log('   ' + line);
}

if (!live) {
  console.log('\nOffline only. Run `npm run eval -- --live` for end-to-end answers.\n');
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY || !process.env.TAVILY_API_KEY) {
  console.error('\n--live needs ANTHROPIC_API_KEY and TAVILY_API_KEY in .env\n');
  process.exit(1);
}

const llm = anthropicLLM(new Anthropic());
const search = tavilySearch(process.env.TAVILY_API_KEY);
const model = process.env.MODEL || 'claude-sonnet-5-5';

// A throwaway ledger with the history each prompt presupposes.
const ledger = new Ledger(null);
const base = { userId: 'eval', sessionId: 'old', tz };
let monday = addDays(today, -1);
while (new Date(monday + 'T00:00:00Z').getUTCDay() !== 1) monday = addDays(monday, -1);
ledger.add({ ...base, ts: zonedToUtc(monday, 11, 20, tz).toISOString(), question: 'Shortlist 5 CRM tools for a 20-person outbound sales team, with pricing.', answer: 'Pipedrive Advanced ~$34/user/mo; HubSpot Sales Hub Professional ~$90; Zoho CRM Enterprise ~$40; Freshsales Pro ~$39; Close Growth ~$99 (annual billing).', searches: [] });
ledger.add({ ...base, ts: zonedToUtc(addDays(today, -9), 14, 5, tz).toISOString(), question: 'Which managed Postgres hosting should I use for a small SaaS?', answer: 'Neon Launch ~$5/mo minimum; Supabase Pro $25/mo; Render Postgres from ~$6/mo; AWS RDS from ~$15/mo.', searches: [] });

for (const p of prompts) {
  const t0 = Date.now();
  let firstToken = 0;
  let status: string[] = [];
  console.log(`\n══ ${p}\n`);
  const { answer } = await runTurn(
    { userId: 'eval', sessionId: 'eval_' + Math.random().toString(36).slice(2), message: p, tz, now, history: [] },
    {
      llm, search, ledger, model,
      emit: (e) => {
        if (e.type === 'text' && !firstToken) firstToken = Date.now() - t0;
        if (e.type === 'status' && e.text.startsWith('Searching')) status.push(e.text);
      },
    },
  );
  console.log(answer);
  console.log(`\n   ↳ first token ${(firstToken / 1000).toFixed(1)}s · total ${((Date.now() - t0) / 1000).toFixed(1)}s · ${status.length} searches`);
  status.forEach((s) => console.log('     ' + s));
}
console.log();
