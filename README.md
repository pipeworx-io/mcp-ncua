# NCUA — US credit unions (5300 Call Report)

Financials, membership, branches and ATMs for every federally insured US credit union — **4,336 institutions**, five years of quarterly filings, from the regulator's own 5300 Call Report.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Why this exists alongside `fdic`

They cover disjoint halves of US retail banking, and neither can answer for the other. Credit unions are insured by the NCUSIF, not the FDIC, so they are **absent from FDIC data by definition** — not missing, not incomplete, structurally not there. "How big is my bank" and "how big is my credit union" are two different lookups.

`banking-regulations` is a third thing again: that pack serves NCUA's *rules* (12 CFR 700–799). This one serves the institutions.

## Tools

| Tool | Answers |
|---|---|
| `ncua_search_credit_unions` | *Credit unions in Austin, TX* — fuzzy name, city or state |
| `ncua_credit_union_profile` | *How big is Navy Federal?* — assets, members, loans, shares, branches |
| `ncua_credit_union_financials` | One figure over time, or every figure for a quarter |
| `ncua_rank_credit_unions` | *Largest credit unions in Ohio* — by any mirrored figure |
| `ncua_compare_credit_unions` | Two to five side by side |
| `ncua_account_lookup` | *What is ACCT_010?* — the full 3,376-account dictionary |
| `ncua_branches` | Branch and ATM locations by credit union or place |
| `ncua_industry_totals` | *How many credit unions are there?* — national or per state |

## Auth

Keyless.

## The account dictionary is the product

The 5300 Call Report stores every figure against an opaque code, and the meaning lives in a **separate file**:

```
FS220.txt : CU_NUMBER, CYCLE_DATE, ACCT_010, ACCT_083, ...
            1,         3/31/2026,  13376472, 7678,     ...

AcctDesc  : ACCT_010 -> "TOTAL ASSETS"
            ACCT_083 -> "Number of current members (not number of accounts)"
```

`ACCT_010: 13376472` is not an answer. **Every tool that returns a value joins the dictionary and returns the label with it**, and `ncua_account_lookup` resolves any code — including the 3,179 that have a definition but no reported values.

## What is mirrored, and what is not

We store the **197 accounts NCUA itself flags as its Financial Performance Report**, which is NCUA's curation rather than ours. That is ~165k non-zero values a quarter; the full 3,376 would be 1.33M a quarter, eight times the storage for a long tail nobody has asked for.

The complete dictionary is mirrored regardless, so an account we hold no values for is still *explainable* rather than unknown — `ncua_account_lookup` returns `mirrored_values: false` for those.

| | |
|---|---|
| Quarters | 20 (2021-06 .. 2026-03) |
| Values | 3.84M |
| Branches / ATMs | 22,829 / 17,588 — **current quarter only** |
| Footprint | 692 MB, of which 440 MB is indexes |

## Why this is a mirror

NCUA publishes **no API**. `ncua.gov/api/*` returns 404, and `mapping.ncua.gov` (the Credit Union Locator) is an Angular app that serves the same HTML for every path — it is a client-side UI, not an endpoint. The only machine-readable form is the quarterly bulk archive, ~7.7 MB compressed across 26 files.

Ingest: `workers/data-pipeline/src/datasets/ncua.ts` (scheduled) and `scripts/ingest-ncua.mjs` (backfill and one-off repair). Schema: `supabase/migrations/071_ncua.sql`.

## Data sources

- <https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data> — the quarterly archive index.
- `https://ncua.gov/files/publications/analysis/call-report-data-YYYY-MM.zip` — one release.

### Things the next person would otherwise rediscover

- **Three URL conventions for the same file.** `call-report-data-2016-03.zip` (current), `Call-Report-Data-2015-06.zip` (capitalised), and older `QCR201406.zip` under `/files/publications/data-apps/`. A resolver that knows only the current one silently starts history in 2016.
- **~56-day publication lag.** The 2026-03-31 cycle was stamped 2026-05-26. The current calendar quarter is normally *not* the newest data. The freshness SLA is 200 days for this reason; anything tighter false-fails every cycle.
- **Not every account code starts with `ACCT_`.** NCUA's diversity fields are `BOARDBLACKAMERICAN`, `CURMEMHISPANICAMERICAN`, `FOMMINORITYSTATUS`. Filtering columns on `/^ACCT_/` looks harmless and silently drops all 15 of them — the whole minority-depository dataset.
- **The data is 91% sparse, and the zeros are real.** `FS220K.txt` is entirely zero in some quarters. That is what the source says; do not coerce it to null.
- **A missing credit union merged or liquidated.** The count falls every quarter (5,136 in 2021 → 4,336 now). An empty result for a charter is not a bad charter number.
- **`CU_NUMBER` is NCUA's charter number, not `RSSD`.** Both are carried; `RSSD` is the join key to Fed/FFIEC data.
- **`net_income` (`ACCT_602`) is reported by fewer than half of credit unions** — NCUA requires it only when the amount is not already inside Undivided Earnings. A null there is a filing rule, not zero income, and the response says so.
- **No coordinates.** NCUA publishes branch addresses without lat/lon, so location search is a text match on city/state/ZIP. Do not promise "near me".

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ncua": {
      "url": "https://gateway.pipeworx.io/ncua/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ncua/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ncua": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ncua"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ncua
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ncua data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
