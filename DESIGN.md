# DESIGN

**One idea:** the three example questions aren't search problems, they're *time* problems. "Monday", "3 November" and "last Tuesday" are references into the agent's own past. A model with web search but no clock and no memory will answer them confidently and wrongly. So the architecture puts everything exact in code, before the model runs, and leaves the model only the judgement.

## How a turn works

```
message ─► resolve dates (code) ─► recall past turns (code) ─► per-turn system block ─► model loop ─► ledger
              time.ts                  ledger.ts                 clock + dates + memory     agent.ts
```

1. **Dates are resolved in code, never by the model.** `time.ts` turns "last Tuesday" into calendar days using the user's browser time zone. English is genuinely ambiguous here (on a Wednesday it means 10 Nov *or* 3 Nov), so the resolver returns *candidates* and flags the ambiguity; it doesn't guess. Time zone matters: at 00:30 IST it is still "yesterday" in UTC.
2. **Memory is a verbatim, dated ledger, retrieved before the model runs.** Every turn is appended to JSONL with timestamp, zone, full answer and the searches behind it. Recall is date-first (candidate days from step 1), keyword-second. This is how "last Tuesday" disambiguates itself: 10 Nov has no record, 3 Nov has a Postgres answer, so that is the turn. If nothing is recorded for the dates mentioned, the model is told so explicitly and the prompt forbids pretending to remember.
3. **Delta-aware prompting.** For "what changed / is it still right" the prompt prescribes a procedure: extract the claims made *then*, search each from that date forward (`since` maps to a real search-engine date filter), also check the current state directly (a changelog search misses quiet price changes), and report **Changed / Unchanged / Couldn't verify**, leading with the verdict.
4. **Model loop.** Streams text; all `web_search` calls in one step run in parallel; at most 3 tool rounds, 8 searches per turn; the last round sets `tool_choice: none` so the loop *cannot* end without an answer. Search failures return as text the model must report, never as a crash or silent guess.

## Why it's built this way

- **Fast.** Retrieval and date math are microseconds of code, not extra model calls. The model is told to plan every search up front and issue them together, so typical turns are one tool round. Tokens stream immediately; the UI shows what is being searched. The static prompt is cache-marked and the volatile part (clock, memory) comes after it so the cache isn't busted. Search results are cut to ~600 chars each; identical queries are cached for 5 min and de-duplicated within a turn. No thinking tokens, no planner/critic model calls.
- **Right.** Exact things are done exactly (tested: 39 tests incl. the IST midnight boundary, ambiguous weekdays, torn ledger writes). The model must date every time-sensitive claim and cite pages it actually saw. Retrieved text is declared data, not instructions.
- **Good to talk to.** Lead with the verdict, short, one question at most and only if blocked. Honest about gaps in one clause rather than hedging throughout.
- **One tool, honoured literally.** Memory is *not* a tool. It is code in front of the model, so the agent has exactly one tool and memory costs no round-trips.

## Considered and rejected

- **LLM-written summary memory / vector DB.** Summaries drop the two things that matter here: the exact date and the exact claims to re-verify. Embeddings are fuzzy where a date is exact. At this scale a date index + keyword overlap beats both and is debuggable in one read.
- **Memory (or "get_date") as a second tool.** Costs a round-trip on exactly the questions that most need to be fast, and breaks the one-tool brief.
- **Letting the model resolve "last Tuesday".** Plausible and wrong often enough to matter; and it can't be unit-tested.
- **Planner → searcher → critic multi-agent pipeline.** 3x latency for marginal gains on questions this shaped. A single loop with a good prompt and a hard budget wins on speed, and the failure modes are legible.
- **Agent framework (LangChain etc.).** The loop is ~80 lines; a framework would hide the part that matters. Plain `node:http` + SSE, no build step.
- **Fetching full pages.** Better evidence but slow and outside "one tool". Snippets from primary sources are enough for pricing/changelog questions; the model is told to say when they aren't.

## Known limits (honest)

- Search snippets can miss a price change that lives behind a JS pricing toggle; the agent says "couldn't verify" rather than "no change", but a page-fetch tool would do better.
- Recall is keyword-based; a paraphrased topic with no shared words won't match on topic alone (date still works).
- Ledger is a local JSONL file: single process, no auth. The user id is a browser-generated random id, not an identity.
- I ran the full stack (SDK streaming, tool round-trip, UI) against a fake model server and the unit suite, but not against live Anthropic/Tavily from my sandbox. `npm run eval -- --live` does that in one command.

## With another week

1. **Eval set with a judge**: ~50 "since X" questions with frozen search fixtures, scoring claim-level correctness and date-citing, so prompt changes are measured not felt.
2. **Verify-on-delta**: for each recalled claim, a deterministic claim→query step plus a second look at the vendor's own pricing page via a fetch backend.
3. **Embedding fallback** for topic recall, only when date + keyword both miss.
4. **Proactive "watch"**: record the claims worth monitoring and re-check on a schedule, so "has anything changed?" is answered before it's asked.
5. Real auth + Postgres for the ledger; per-user rate limits; tracing of every turn (searches, tokens, latency).
