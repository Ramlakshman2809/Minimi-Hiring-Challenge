/**
 * HTTP server: no framework. Three routes and a static file.
 *   POST /api/chat    -> Server-Sent Events stream of AgentEvent
 *   GET  /api/memory  -> the user's recorded turns (transparency/debugging)
 *   GET  /            -> the chat UI
 */
import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { anthropicLLM, runTurn, type AgentEvent } from './agent.ts';
import { Ledger } from './ledger.ts';
import { tavilySearch } from './search.ts';
import { isValidTz, systemTz } from './time.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`\nMissing ${name}. Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return v;
}

const llm = anthropicLLM(new Anthropic({ apiKey: need('ANTHROPIC_API_KEY') }));
const search = tavilySearch(need('TAVILY_API_KEY'));
const ledger = new Ledger(process.env.LEDGER_PATH || 'data/ledger.jsonl');
const DEFAULT_TZ = isValidTz(process.env.DEFAULT_TZ) ? process.env.DEFAULT_TZ : systemTz();

const clock = (): Date => {
  const o = process.env.NOW_OVERRIDE;
  const d = o ? new Date(o) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

// Session history holds only the text of prior turns; tool traffic is dropped after each turn.
type Hist = Array<{ role: 'user' | 'assistant'; content: string }>;
const sessions = new Map<string, { hist: Hist; busy: boolean }>();
const MAX_HISTORY = 16;

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)));

function readJson(req: IncomingMessage, limit = 32_768): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const id = (v: unknown) => (typeof v === 'string' && /^[\w-]{3,64}$/.test(v) ? v : null);

async function chat(req: IncomingMessage, res: ServerResponse) {
  let body: any;
  try {
    body = await readJson(req);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  const userId = id(body.userId);
  const sessionId = id(body.sessionId);
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4000) : '';
  if (!userId || !sessionId || !message) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'userId, sessionId and message are required' }));
    return;
  }
  const tz = isValidTz(body.tz) ? body.tz : DEFAULT_TZ;

  const s = sessions.get(sessionId) ?? { hist: [], busy: false };
  sessions.set(sessionId, s);
  if (sessions.size > 500) sessions.delete(sessions.keys().next().value!);
  if (s.busy) {
    res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'still answering the previous message' }));
    return;
  }
  s.busy = true;

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (e: AgentEvent) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
  };

  const ac = new AbortController();
  res.on('close', () => ac.abort()); // user closed the tab / hit stop: stop spending tokens

  try {
    const { answer } = await runTurn(
      { userId, sessionId, message, tz, now: clock(), history: s.hist.slice(-MAX_HISTORY) },
      { llm, search, ledger, model: MODEL, emit: send, signal: ac.signal },
    );
    s.hist.push({ role: 'user', content: message }, { role: 'assistant', content: answer || '(no answer)' });
    if (s.hist.length > MAX_HISTORY * 2) s.hist.splice(0, s.hist.length - MAX_HISTORY * 2);
  } catch (e) {
    if (!ac.signal.aborted) {
      console.error('[turn failed]', e);
      send({ type: 'error', text: friendly(e) });
    }
  } finally {
    s.busy = false;
    res.end();
  }
}

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|authentication|api[_ -]?key/i.test(msg)) return 'The model API key was rejected. Check ANTHROPIC_API_KEY in .env.';
  if (/429|rate|overloaded|529/i.test(msg)) return 'The model is busy right now. Try again in a few seconds.';
  return 'Something went wrong on my side. Please try again.';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, res);
    if (req.method === 'GET' && url.pathname === '/api/memory') {
      const u = id(url.searchParams.get('userId'));
      const turns = u ? ledger.list(u).slice(-50).map(({ id, ts, day, question, searches }) => ({ id, ts, day, question, searches: searches.map((x) => x.query) })) : [];
      return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ turns }));
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Chat agent ready → http://${HOST}:${PORT}   (model: ${MODEL}, tz: ${DEFAULT_TZ}, ${ledger.size} remembered turns)\n`);
});
