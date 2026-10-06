# Tour Scout

An agent that routes tours for independent musicians, built on Qloo's taste graph.

Give it an artist and a region. It ranks the metros where that artist's audience over-indexes, builds a drivable route from the top of that ranking, books a realistic opener (one whose fans overlap the headliner's and who is not bigger than the headliner), and hands back a plan where every stop cites the Qloo calls behind it. A comparison panel then scores the same request answered by a generic LLM against the same Qloo evidence.

## Why Qloo is the differentiator

A general-purpose model asked "where should this artist tour?" guesses from the artist's biography. Asked about Lomelda, a singer-songwriter from Texas, it routes a Texas-and-Plains run (Austin, Dallas, Norman, Kansas City, Omaha). Qloo's heatmap ranks her audience densest in Austin, then Seattle, San Francisco, Boston and New York; of 135 ranked US metros, that Kansas City is #43 and Omaha does not rank. Scored against the same heatmap, the generic plan put 2 of 5 stops in her top 20 metros (median rank #35) and Tour Scout put 5 of 5 (median #3). Tour Scout's planning is built on those signals, and the plan shows its evidence so a manager can check it.

## How it works

The agent (Gemini or Claude, via function calling) plans with eight tools. Six of them call Qloo, mostly through the official harness (`qloo mcp`); each Qloo call is recorded as numbered evidence (E1, E2, ...).

| Agent tool | Qloo workflow | What it adds |
| --- | --- | --- |
| `resolve_artist` | `qloo_describe` | Pins the exact entity before anything else |
| `find_fan_cities` | Insights heatmap (`GET /v2/insights`, `filter.type=urn:heatmap`), requested by the backend | Every heatmap cell in the region, averaged per metro (GeoNames cities of 100k+), ranked |
| `find_opener_candidates` | `qloo_recommend` | Artists whose fans overlap the headliner's |
| `rank_openers_for_city` | `qloo_rank` with `signal_location` | Best opener for that city's audience that is not bigger than the headliner |
| `check_momentum` | `qloo_trends` | Rising or cooling interest for headliner and openers |
| `audience_snapshot` | `qloo_audience_demographics`, `qloo_entity_tags` | The marketing angle, at aggregate level only |
| `plan_route` | none (local) | Shortest open route (nearest neighbour + 2-opt), leg distances |
| `submit_tour_plan` | none | Structured plan; rejected if a stop cites unknown evidence, and sent back once if it skips the #1 metro or books an opener bigger than the headliner |

The heatmap is requested directly because `qloo_where_popular` keeps only the top 20 cells, which for smaller artists are sparse rural cells where a few fans saturate the score. Live Qloo calls share two slots and retry after a 429.

The server streams every tool call and every Qloo request to the page as it happens, so the reasoning is visible, not just the answer.

**Versus a generic LLM.** After a plan, one button sends the same request to the same Gemini models with no tools and no Qloo. Both plans are scored against the artist's Qloo heatmap for the region (each stop's metro rank, stops in the top 20, median rank, top-10 metros missed), and every opener from both plans is ranked in one Qloo call with the headliner as the signal, so the opener scores are comparable.

## Run it

Requires Node.js 22.19 or newer.

```sh
npm install
cp .env.example .env   # then fill in the keys, or export them in your shell
npm start              # http://localhost:8787
```

| Variable | Purpose |
| --- | --- |
| `QLOO_API_KEY` | Event-issued Qloo key. Without it the app runs on clearly labelled sample data. |
| `GEMINI_API_KEY` | Gemini key for the agent (free tier works). |
| `GEMINI_MODEL` | Comma-separated fallback list; a model that is unavailable or out of quota falls through to the next. |
| `ANTHROPIC_API_KEY` | Use Claude as the agent instead (`CLAUDE_MODEL`, default `claude-opus-5`; `CLAUDE_EFFORT`, default `medium`). |
| (none) | Without a model key, a fixed playbook runs over the same tools so the app stays demoable. |
| `RUNS_PER_HOUR`, `MAX_CONCURRENT` | Demo protection for the shared Qloo quota. Identical requests are cached for six hours. |

Keys stay on the server. The browser only talks to `/api/plan`, `/api/compare` and `/api/health`. The comparison panel needs `GEMINI_API_KEY`.

Shareable links prefill and run a plan: `/?artist=Lomelda&within=United%20States&stops=5`.

## Deploy

The `Dockerfile` runs the server as a container (the Qloo harness starts `qloo mcp` as a child process, so serverless functions are not supported). Set `QLOO_API_KEY` and `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) as secrets on the host.

## What a plan does not establish

- Affinity is relative interest in an area compared with the baseline. It is not a ticket-sales forecast, venue availability, or a guarantee of turnout.
- Heatmap cells are averaged into metros of at least 100,000 people; smaller towns (Asheville, Lawrence) can't be stops yet, and the comparison panel doesn't score them.
- Opener scores are comparable only within one Qloo call.
- Qloo trends were flat on the hackathon data, so momentum is reported but not relied on.
- The generic LLM's answer varies between runs; the panel shows one run, cached for six hours.
- Comedians resolve in Qloo as people rather than artists and aren't supported yet.
- No personal data is sent to Qloo. Audience results are aggregate and are never used to profile individuals.

## Credits

Taste data from [Qloo](https://qloo.com). City coordinates from [GeoNames](https://www.geonames.org) (CC BY 4.0). Map tiles © OpenStreetMap contributors.

## License

MIT
