# Chat agent with web search and dated memory

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY and TAVILY_API_KEY
npm run dev               # http://localhost:3000
```

Try the three headline questions with pre-seeded history:

```bash
npm run seed              # fake past chats, dated relative to today
# open http://localhost:3000/?u=demo
```

| Command | What it does |
|---|---|
| `npm run dev` | server with reload |
| `npm test` | 39 tests: dates, ledger recall, agent loop (no network) |
| `npm run eval` | prints how the three example prompts resolve (no keys needed) |
| `npm run eval -- --live` | runs them end to end with latency and searches used |
| `npm run typecheck` | `tsc --noEmit` |

Architecture, trade-offs and next steps are in [DESIGN.md](./DESIGN.md).

```
src/time.ts     deterministic date resolution ("last Tuesday" → candidate days)
src/ledger.ts   append-only dated memory + date-first recall
src/search.ts   the one tool: Tavily web search, cached, with a `since` filter
src/agent.ts    one turn: context assembly + bounded parallel tool loop
src/server.ts   node:http + SSE, no framework
public/         single-file chat UI
```
