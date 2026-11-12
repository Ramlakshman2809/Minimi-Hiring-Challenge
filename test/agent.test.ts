import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { runTurn, MAX_ROUNDS, type AgentEvent, type LLM, type StreamParams } from '../src/agent.ts';
import { Ledger } from '../src/ledger.ts';
import type { SearchFn } from '../src/search.ts';

const IST = 'Asia/Kolkata';
const NOW = new Date('2026-11-11T16:22:00Z');

type Script = Array<{ text?: string; tools?: Array<{ query: string; since?: string }> }>;

/** A scripted fake model that records exactly what it was sent. */
function fakeLLM(script: Script) {
  const calls: StreamParams[] = [];
  const llm: LLM = {
    async stream(params, onText) {
      calls.push(structuredClone(params));
      const step = script[Math.min(calls.length - 1, script.length - 1)]!;
      if (step.text) onText(step.text);
      const content: Anthropic.ContentBlock[] = [];
      if (step.text) content.push({ type: 'text', text: step.text, citations: null } as any);
      (step.tools ?? []).forEach((t, i) =>
        content.push({ type: 'tool_use', id: `tu_${calls.length}_${i}`, name: 'web_search', input: t } as any),
      );
      return { content, stop_reason: step.tools?.length ? 'tool_use' : 'end_turn' } as Anthropic.Message;
    },
  };
  return { llm, calls };
}

const okSearch: SearchFn = async (a) => [{ title: `Result for ${a.query}`, url: `https://example.com/${encodeURIComponent(a.query)}`, snippet: 'snippet' }];

function run(script: Script, opts: { message?: string; search?: SearchFn; ledger?: Ledger; history?: any[] } = {}) {
  const { llm, calls } = fakeLLM(script);
  const events: AgentEvent[] = [];
  const ledger = opts.ledger ?? new Ledger(null);
  const p = runTurn(
    { userId: 'u1', sessionId: 's1', message: opts.message ?? 'hello', tz: IST, now: NOW, history: opts.history ?? [] },
    { llm, search: opts.search ?? okSearch, ledger, model: 'm', emit: (e) => events.push(e) },
  );
  return { p, calls, events, ledger };
}

test('chit-chat: one model call, no search, recorded to the ledger', async () => {
  const r = run([{ text: 'Hi!' }]);
  const out = await r.p;
  assert.equal(r.calls.length, 1);
  assert.equal(out.answer, 'Hi!');
  assert.equal(r.ledger.size, 1);
  assert.equal(r.events.at(-1)!.type, 'done');
});

test('parallel searches run concurrently in a single round', async () => {
  let inFlight = 0, peak = 0;
  const slow: SearchFn = async (a) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 30));
    inFlight--;
    return okSearch(a);
  };
  const r = run([{ tools: [{ query: 'a' }, { query: 'b' }, { query: 'c' }] }, { text: 'done' }], { search: slow });
  await r.p;
  assert.equal(peak, 3);
  assert.equal(r.calls.length, 2); // one tool round + the answer
});

test('every tool_use gets a tool_result, in the next user message', async () => {
  const r = run([{ tools: [{ query: 'a' }, { query: 'b' }] }, { text: 'ok' }]);
  await r.p;
  const second = r.calls[1]!.messages;
  const last = second.at(-1)!;
  assert.equal(last.role, 'user');
  const ids = (last.content as any[]).map((b) => b.tool_use_id);
  assert.deepEqual(ids, ['tu_1_0', 'tu_1_1']);
});

test('the final allowed round forbids tools, so the loop always ends with an answer', async () => {
  const forever: Script = [{ tools: [{ query: 'again' }] }];
  const r = run([...Array(MAX_ROUNDS - 1).fill(forever[0]), { text: 'final' }].map((s, i) => (i < MAX_ROUNDS - 1 ? { tools: [{ query: 'q' + i }] } : s)));
  const out = await r.p;
  assert.equal(r.calls.length, MAX_ROUNDS);
  assert.deepEqual(r.calls.at(-1)!.tool_choice, { type: 'none' });
  assert.equal(r.calls[0]!.tool_choice, undefined);
  assert.equal(out.answer, 'final');
});

test('search failure is handed to the model as an error result, not thrown', async () => {
  const boom: SearchFn = async () => { throw new Error('provider down'); };
  const r = run([{ tools: [{ query: 'x' }] }, { text: 'could not verify' }], { search: boom });
  const out = await r.p;
  assert.equal(out.answer, 'could not verify');
  const tr = (r.calls[1]!.messages.at(-1)!.content as any[])[0];
  assert.equal(tr.is_error, true);
  assert.match(tr.content, /SEARCH FAILED: provider down/);
});

test('identical calls in one turn hit the search backend once', async () => {
  let n = 0;
  const counting: SearchFn = async (a) => { n++; return okSearch(a); };
  const r = run([{ tools: [{ query: 'same' }, { query: 'same' }] }, { text: 'ok' }], { search: counting });
  await r.p;
  assert.equal(n, 1);
});

test('per-turn search budget is enforced', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ query: 'q' + i }));
  let n = 0;
  const counting: SearchFn = async (a) => { n++; return okSearch(a); };
  const r = run([{ tools: many }, { text: 'ok' }], { search: counting });
  await r.p;
  assert.equal(n, 8);
});

test('the system prompt carries resolved dates and recalled memory; the static block is cache-marked', async () => {
  const ledger = new Ledger(null);
  ledger.add({ userId: 'u1', sessionId: 'old', tz: IST, ts: '2026-11-03T08:35:00Z', question: 'Postgres hosting pricing?', answer: 'Neon $5', searches: [] });
  const r = run([{ text: 'ok' }], { ledger, message: 'Last Tuesday I asked you about Postgres hosting. Has pricing changed?' });
  await r.p;
  const sys = r.calls[0]!.system as Anthropic.TextBlockParam[];
  assert.deepEqual(sys[0]!.cache_control, { type: 'ephemeral' });
  assert.equal(sys[1]!.cache_control, undefined); // volatile part must not break the cached prefix
  assert.match(sys[1]!.text, /Wednesday 11 November 2026, 21:52 \(Asia\/Kolkata\)/);
  assert.match(sys[1]!.text, /Tue 10 Nov 2026 or Tue 3 Nov 2026/);
  assert.match(sys[1]!.text, /use_since="2026-11-03"/);
  assert.match(sys[1]!.text, /YOUR ANSWER AT THE TIME: Neon \$5/);
});

test('no dates and no memory cue → system block is just the clock', async () => {
  const r = run([{ text: 'ok' }], { message: 'What is a B-tree?' });
  await r.p;
  const sys = r.calls[0]!.system as Anthropic.TextBlockParam[];
  assert.doesNotMatch(sys[1]!.text, /dates_resolved|<memory/);
});

test('the ledger stores the final answer and the searches behind it', async () => {
  const r = run([{ text: 'Checking.', tools: [{ query: 'neon pricing', since: '2026-11-03' }] }, { text: 'Neon is unchanged.' }]);
  const { turn } = await r.p;
  assert.equal(turn.answer, 'Neon is unchanged.'); // not the "Checking." preamble
  assert.deepEqual(turn.searches.map((s) => [s.query, s.since]), [['neon pricing', '2026-11-03']]);
  assert.equal(turn.day, '2026-11-11');
});

test('malformed tool input yields an error result instead of a crash', async () => {
  const { llm, calls } = fakeLLM([{ tools: [{ query: '   ' }] }, { text: 'ok' }]);
  const ledger = new Ledger(null);
  await runTurn(
    { userId: 'u', sessionId: 's', message: 'x', tz: IST, now: NOW, history: [] },
    { llm, search: okSearch, ledger, model: 'm', emit: () => {} },
  );
  const tr = (calls[1]!.messages.at(-1)!.content as any[])[0];
  assert.equal(tr.is_error, true);
});
