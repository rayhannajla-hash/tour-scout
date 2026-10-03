# Tour Scout

An agent that routes tours for independent musicians and comedians, built on Qloo's taste graph.

Give it an artist and a region. It finds the cities where that artist's audience over-indexes, ranks opening acts city by city by shared audience, checks whether interest is rising, orders the stops into a drivable route, and hands back a plan where every stop cites the Qloo calls behind it.

## Why Qloo is the differentiator

A general-purpose model asked "where should this artist tour?" answers from fame and population: New York, Los Angeles, Chicago. It cannot know that an artist over-indexes in Columbus but under-indexes in Miami. Qloo's geographic affinity heatmap measures that directly, and its audience overlap ranks openers per city rather than one opener for the whole run. Tour Scout's planning is built on those signals, and the plan shows its evidence so a manager can check it.

## How it works

The agent (Gemini or Claude, via function calling) plans with eight tools. Six of them wrap Qloo workflows from the official harness (`qloo mcp`); each Qloo call is recorded as numbered evidence (E1, E2, ...).

| Agent tool | Qloo workflow | What it adds |
| --- | --- | --- |
| `resolve_artist` | `qloo_describe` | Pins the exact entity before anything else |
| `find_fan_cities` | `qloo_where_popular` | Heatmap points snapped to the nearest metro (GeoNames), one row per city |
| `find_opener_candidates` | `qloo_recommend` | Artists whose fans overlap the headliner's |
| `rank_openers_for_city` | `qloo_rank` with `signal_location` | A different best opener per city |
| `check_momentum` | `qloo_trends` | Rising or cooling interest for headliner and openers |
| `audience_snapshot` | `qloo_audience_demographics`, `qloo_entity_tags` | The marketing angle, at aggregate level only |
| `plan_route` | none (local) | Shortest open route (nearest neighbour + 2-opt), leg distances |
| `submit_tour_plan` | none | Structured plan; rejected if a stop cites unknown evidence |

The server streams every tool call and every Qloo request to the page as it happens, so the reasoning is visible, not just the answer.

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

Keys stay on the server. The browser only talks to `/api/plan` and `/api/health`.

Shareable links prefill and run a plan: `/?artist=Phoebe%20Bridgers&within=United%20States&stops=5`.

## Deploy

The `Dockerfile` runs the server as a container (the Qloo harness starts `qloo mcp` as a child process, so serverless functions are not supported). Set `QLOO_API_KEY` and `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) as secrets on the host.

## What a plan does not establish

- Affinity is relative interest in an area compared with the baseline. It is not a ticket-sales forecast, venue availability, or a guarantee of turnout.
- Heatmap cells are snapped to the nearest metro with at least 100,000 people; small college towns can fold into a nearby city.
- Opener rankings compare candidates within one city only; scores from different cities are not comparable.
- No personal data is sent to Qloo. Audience results are aggregate and are never used to profile individuals.

## Credits

Taste data from [Qloo](https://qloo.com). City coordinates from [GeoNames](https://www.geonames.org) (CC BY 4.0). Map tiles © OpenStreetMap contributors.

## License

MIT
