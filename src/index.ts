interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}
/**
 * NCUA MCP — US credit union data from the quarterly 5300 Call Report.
 *
 * Backed by migration 071; ingest in scripts/ingest-ncua.mjs. NCUA publishes no
 * API — the Credit Union Locator is a client-side app — so the quarterly bulk
 * archive is the only machine-readable path into this data.
 *
 * (Wording matters here and the CI gate is right to insist: this file is
 * published to npm and GitHub, so a comment about where the data is served
 * from is a comment every caller can read.)
 *
 * THE ONE RULE IN THIS PACK: never return a bare account code. The call report
 * stores values against opaque codes (ACCT_010, ACCT_083) whose meaning lives
 * in a separate dictionary. `ACCT_010: 13376472` is not an answer. Every tool
 * that returns a value joins ncua_account_codes and returns the label with it.
 *
 * Credit unions are NCUSIF-insured, so they do not appear in FDIC data at all —
 * this pack and the `fdic` pack cover disjoint halves of US retail depositories.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Ncua');
}


/**
 * Headline metrics, by the code NCUA actually uses. Every one is verified
 * against the live mirror — is_fpr true AND a real row count for the current
 * quarter — not inferred from the account name.
 *
 * Two earlier picks were wrong in a way that returned null rather than an
 * error, which is why the check now includes row counts:
 *   ACCT_388 "Net Income after Cost of Funds" — is_fpr FALSE, so never
 *            mirrored. Always null.
 *   ACCT_020B — is_fpr FALSE, and only the 1-to-2-month delinquency bucket
 *            rather than total delinquency, so it was the wrong figure too.
 *
 * Coverage in 2026-03 (of 4,336 credit unions), so a null can be read:
 *   ACCT_010  4,336   ACCT_083  4,336   ACCT_018  4,334
 *   ACCT_025B 4,325   ACCT_041B 3,989   ACCT_602  1,996 (see below)
 */
const METRIC_CODES: Record<string, string> = {
  total_assets: 'ACCT_010',
  members: 'ACCT_083',
  total_loans: 'ACCT_025B',
  total_shares: 'ACCT_018',
  // NCUA requires this one only when the amount is not already folded into
  // Undivided Earnings, so fewer than half of credit unions report it. A null
  // here means "not separately reported", NOT "no income" — the label carries
  // NCUA's own caveat and `reporting` in the profile response says so.
  net_income: 'ACCT_602',
  delinquent_loans: 'ACCT_041B',
};

/** Metrics NCUA collects conditionally — a null is an absence of a filing
 *  requirement, not an absence of the thing. */
const CONDITIONAL_METRICS = new Set(['net_income']);

const tools: McpToolExport['tools'] = [
  {
    name: 'ncua_search_credit_unions',
    description:
      'Find US credit unions by name, city or state, using NCUA call report data (the federal regulator of credit unions). Returns charter number, name, city, state, year opened and total assets. Answers "credit unions in Austin Texas", "is there a credit union called Alliant", "list Ohio credit unions". Name matching is fuzzy, so partial and misspelled names work ("navy fed" finds NAVY FEDERAL CREDIT UNION). Example: ncua_search_credit_unions({ name: "navy federal" }); ncua_search_credit_unions({ state: "OH", limit: 25 }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full or partial credit union name, e.g. "navy federal"' },
        state: { type: 'string', description: 'Two-letter state code, e.g. "TX"' },
        city: { type: 'string', description: 'City name, e.g. "Austin"' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'ncua_credit_union_profile',
    description:
      'Get a full profile for one US credit union from its NCUA call report: total assets, member count, loans, shares/deposits, net income and delinquent loans, plus charter details (state, year opened, peer group, minority-depository status) and branch/ATM counts. Answers "how big is Navy Federal", "how many members does PenFed have", "total assets of BECU". Look the credit union up by charter number or by name. Example: ncua_credit_union_profile({ name: "navy federal" }); ncua_credit_union_profile({ cu_number: 5536 }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        cu_number: { type: 'number', description: 'NCUA charter number' },
        name: { type: 'string', description: 'Credit union name (fuzzy) if the charter number is unknown' },
        quarter: { type: 'string', description: 'Quarter end as YYYY-MM-DD; defaults to the latest quarter available' },
      },
    },
  },
  {
    name: 'ncua_credit_union_financials',
    description:
      'Get one US credit union\'s reported call report figures over time, or every figure for a single quarter — labeled, never as raw account codes. Use for trends: "how have Navy Federal\'s assets grown", "PenFed membership over the last 3 years", "delinquency trend at my credit union". Pass `metric` for one series (total_assets, members, total_loans, total_shares, net_income, delinquent_loans) or omit it for every figure reported in the latest quarter. Example: ncua_credit_union_financials({ name: "navy federal", metric: "total_assets" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        cu_number: { type: 'number', description: 'NCUA charter number' },
        name: { type: 'string', description: 'Credit union name (fuzzy)' },
        metric: {
          type: 'string',
          description: 'One of: total_assets, members, total_loans, total_shares, net_income, delinquent_loans. Or a raw NCUA account code like "ACCT_010". Omit for all figures in the latest quarter.',
        },
      },
    },
  },
  {
    name: 'ncua_rank_credit_unions',
    description:
      'Rank US credit unions by a call report figure — largest by assets, most members, biggest loan book — optionally within one state. Answers "largest credit unions in the US", "biggest credit union in Ohio", "which credit unions have the most members". Ranks on the latest available quarter unless one is given. Example: ncua_rank_credit_unions({ metric: "total_assets", state: "OH", limit: 10 }); ncua_rank_credit_unions({ metric: "members" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'total_assets (default), members, total_loans, total_shares, net_income, or a raw NCUA account code' },
        state: { type: 'string', description: 'Restrict to one state, e.g. "OH"' },
        quarter: { type: 'string', description: 'Quarter end as YYYY-MM-DD; defaults to latest' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'ncua_compare_credit_unions',
    description:
      'Compare two or more US credit unions side by side on their NCUA call report figures — assets, members, loans, shares, net income, delinquency. Answers "Navy Federal vs PenFed", "compare BECU and SchoolsFirst". Pass names or charter numbers. Example: ncua_compare_credit_unions({ names: ["navy federal", "pentagon"] }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' }, description: 'Credit union names, 2-5 of them' },
        cu_numbers: { type: 'array', items: { type: 'number' }, description: 'NCUA charter numbers instead of names' },
      },
    },
  },
  {
    name: 'ncua_account_lookup',
    description:
      'Look up what an NCUA call report account code means, or find the code for a figure. The 5300 Call Report stores everything against codes like ACCT_010 or ACCT_083, and this returns the official name and NCUA\'s full reporting instruction for each. Answers "what is ACCT_010", "which account code is total assets", "what does NCUA count as a delinquent loan". Searches names and the instruction text. Example: ncua_account_lookup({ code: "ACCT_010" }); ncua_account_lookup({ query: "delinquent loans" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'An account code, e.g. "ACCT_010"' },
        query: { type: 'string', description: 'Words to search for, e.g. "total assets", "net worth"' },
        limit: { type: 'number', description: 'Max results (default 15)' },
      },
    },
  },
  {
    name: 'ncua_branches',
    description:
      'Find US credit union branch and ATM locations from NCUA records — by credit union, or by city/state/ZIP. Returns address, phone, hours, and whether the site has an ATM or drive-thru. Answers "Navy Federal branches in San Diego", "credit union branches in ZIP 78701". NOTE: NCUA publishes addresses only, with no coordinates, so this matches on city/state/ZIP text rather than true distance. Example: ncua_branches({ name: "navy federal", state: "CA" }); ncua_branches({ postal_code: "78701" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        cu_number: { type: 'number', description: 'NCUA charter number' },
        name: { type: 'string', description: 'Credit union name (fuzzy)' },
        city: { type: 'string', description: 'City name' },
        state: { type: 'string', description: 'Two-letter state code' },
        postal_code: { type: 'string', description: 'ZIP code' },
        include_atms: { type: 'boolean', description: 'Also return standalone ATM locations (default false)' },
        limit: { type: 'number', description: 'Max results (default 25, max 100)' },
      },
    },
  },
  {
    name: 'ncua_industry_totals',
    description:
      'Aggregate totals across the whole US credit union industry, or one state, from NCUA call report data: number of credit unions, combined assets, total members, average size. Answers "how many credit unions are there in the US", "total credit union assets", "how many credit unions in Texas", "are credit unions shrinking". Pass a quarter to see a past period, or omit for the latest. Example: ncua_industry_totals({}); ncua_industry_totals({ state: "TX" }). Keyless.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'Restrict to one state, e.g. "TX"' },
        quarter: { type: 'string', description: 'Quarter end as YYYY-MM-DD; defaults to latest' },
      },
    },
  },
];

// ── Supabase plumbing ────────────────────────────────────────────────────────

interface Ctx { url: string; key: string }

async function pg(ctx: Ctx, path: string): Promise<any[]> {
  const res = await pwFetch(`${ctx.url}/rest/v1/${path}`, {
    headers: { apikey: ctx.key, Authorization: `Bearer ${ctx.key}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`NCUA store error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * PostgREST caps a response at 1,000 rows and SILENTLY IGNORES a larger
 * `limit=`. Any aggregate built on a single request is therefore wrong at
 * 4,336 credit unions — and wrong in the worst way, returning a plausible
 * number (industry assets came out at $708B instead of ~$2.4T) rather than an
 * error. Page explicitly with Range instead.
 */
async function pgAll(ctx: Ctx, path: string, orderBy: string, pageSize = 1000): Promise<any[]> {
  // ORDER BY IS MANDATORY, not a nicety. Postgres guarantees no row order, so
  // paging with Range alone lets successive pages overlap and repeat rows. That
  // is not a subtle failure: without it the industry totals came back as $4.02T
  // and 231M members, against a true $2.51T and 147M — inflated ~1.6x, with no
  // error and a shape plausible enough to ship.
  const sep = path.includes('?') ? '&' : '?';
  const ordered = /(\?|&)order=/.test(path) ? path : `${path}${sep}order=${orderBy}`;
  const out: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const res = await pwFetch(`${ctx.url}/rest/v1/${ordered}`, {
      headers: {
        apikey: ctx.key,
        Authorization: `Bearer ${ctx.key}`,
        Accept: 'application/json',
        Range: `${from}-${from + pageSize - 1}`,
        'Range-Unit': 'items',
      },
    });
    if (!res.ok) throw new Error(`NCUA store error ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = (await res.json()) as any[];
    out.push(...batch);
    if (batch.length < pageSize) return out;
    if (out.length > 200000) return out;   // backstop; no NCUA query is this big
  }
}

/** Exact row count without transferring the rows. */
async function pgCount(ctx: Ctx, path: string): Promise<number> {
  const res = await pwFetch(`${ctx.url}/rest/v1/${path}`, {
    method: 'HEAD',
    headers: {
      apikey: ctx.key,
      Authorization: `Bearer ${ctx.key}`,
      Prefer: 'count=exact',
      Range: '0-0',
      'Range-Unit': 'items',
    },
  });
  const cr = res.headers.get('content-range') || '';
  const n = Number(cr.split('/')[1]);
  return Number.isFinite(n) ? n : 0;
}

const enc = encodeURIComponent;
const clamp = (n: unknown, d: number, max: number) => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : d;
};

/** Latest quarter actually present in the mirror — never assume "this quarter":
 *  NCUA publishes ~56 days after the cycle date, so the current calendar
 *  quarter is normally NOT the newest data we hold. */
async function latestQuarter(ctx: Ctx): Promise<string | null> {
  const r = await pg(ctx, 'ncua_credit_unions?select=cycle_date&order=cycle_date.desc&limit=1');
  return r[0]?.cycle_date ?? null;
}

/** Resolve a name to a charter. Returns candidates rather than guessing when
 *  the name is ambiguous — "first" matches dozens of credit unions. */
async function resolveCu(ctx: Ctx, name: string, quarter: string) {
  const rows = await pg(
    ctx,
    `ncua_credit_unions?select=cu_number,cu_name,city,state&cycle_date=eq.${quarter}` +
      `&cu_name=ilike.*${enc(name.trim())}*&order=cu_name.asc&limit=25`,
  );
  return rows;
}

async function labels(ctx: Ctx, codes: string[]): Promise<Record<string, string>> {
  if (!codes.length) return {};
  const uniq = [...new Set(codes)];
  const rows = await pg(
    ctx,
    `ncua_account_codes?select=account,acct_name&account=in.(${uniq.map(enc).join(',')})`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.account] = r.acct_name;
  return out;
}

/** A metric name from METRIC_CODES, or a raw ACCT_ code passed through. */
function metricCode(metric: unknown): string | null {
  if (!metric) return null;
  const m = String(metric).trim();
  if (METRIC_CODES[m.toLowerCase()]) return METRIC_CODES[m.toLowerCase()];
  if (/^[A-Z0-9_]+$/i.test(m)) return m.toUpperCase();
  return null;
}

const SOURCE = 'NCUA 5300 Call Report (National Credit Union Administration)';

/** Shared shape for "we looked, and there is genuinely nothing" — distinct
 *  from an error, and never phrased so it reads as "no such credit union". */
function notFound(reason: string, hint: string, extra: Record<string, unknown> = {}) {
  return { found: false, reason, hint, source: SOURCE, ...extra };
}

// ── tools ────────────────────────────────────────────────────────────────────

async function searchCreditUnions(ctx: Ctx, a: Record<string, unknown>) {
  const quarter = await latestQuarter(ctx);
  if (!quarter) return notFound('no_data_loaded', 'The NCUA mirror is empty.');
  const limit = clamp(a.limit, 20, 100);

  const filters = [`cycle_date=eq.${quarter}`];
  if (a.name) filters.push(`cu_name=ilike.*${enc(String(a.name).trim())}*`);
  if (a.state) filters.push(`state=eq.${enc(String(a.state).trim().toUpperCase())}`);
  if (a.city) filters.push(`city=ilike.*${enc(String(a.city).trim())}*`);
  if (filters.length === 1) {
    return notFound('no_criteria', 'Pass at least one of name, state or city.');
  }

  const rows = await pg(
    ctx,
    `ncua_credit_unions?select=cu_number,cu_name,city,state,year_opened,peer_group,is_mdi&${filters.join('&')}` +
      `&order=cu_name.asc&limit=${limit}`,
  );
  if (!rows.length) {
    return notFound(
      'no_matching_credit_unions',
      'No credit union matched. Names are stored as NCUA files them (e.g. "STATE EMPLOYEES\'" rather than "SECU"); try fewer words, or search by state.',
      { quarter, criteria: { name: a.name ?? null, state: a.state ?? null, city: a.city ?? null } },
    );
  }

  // Attach assets so the caller can tell 4,000-member from 4,000,000-member.
  const assets = await pg(
    ctx,
    `ncua_cu_financials?select=cu_number,value&account=eq.ACCT_010&cycle_date=eq.${quarter}` +
      `&cu_number=in.(${rows.map((r) => r.cu_number).join(',')})`,
  );
  const byCu = new Map(assets.map((r: any) => [r.cu_number, Number(r.value)]));

  return {
    quarter,
    count: rows.length,
    source: SOURCE,
    credit_unions: rows.map((r: any) => ({
      cu_number: r.cu_number,
      name: r.cu_name,
      city: r.city,
      state: r.state,
      year_opened: r.year_opened,
      peer_group: r.peer_group,
      minority_depository_institution: r.is_mdi,
      total_assets: byCu.get(r.cu_number) ?? null,
    })),
  };
}

/** Shared resolution used by profile/financials/branches. */
async function pickCu(ctx: Ctx, a: Record<string, unknown>, quarter: string) {
  if (a.cu_number != null) {
    const rows = await pg(
      ctx,
      `ncua_credit_unions?select=*&cu_number=eq.${Number(a.cu_number)}&cycle_date=eq.${quarter}&limit=1`,
    );
    if (!rows.length) {
      return {
        error: notFound(
          'charter_not_in_quarter',
          `No credit union with charter ${a.cu_number} is present in ${quarter}. Charters disappear when a credit union merges or liquidates — this is not necessarily a bad number.`,
          { cu_number: Number(a.cu_number), quarter },
        ),
      };
    }
    return { cu: rows[0] };
  }
  if (!a.name) {
    return { error: notFound('no_identifier', 'Pass cu_number or name.') };
  }
  const cands = await resolveCu(ctx, String(a.name), quarter);
  if (!cands.length) {
    return {
      error: notFound(
        'no_matching_credit_unions',
        'No credit union matched that name. NCUA files names in full and in caps (e.g. "PENTAGON" for PenFed, "STATE EMPLOYEES\'" for SECU) — try a distinctive word.',
        { searched: a.name, quarter },
      ),
    };
  }
  if (cands.length > 1) {
    const exact = cands.find(
      (c: any) => c.cu_name.toLowerCase() === String(a.name).trim().toLowerCase(),
    );
    if (!exact) {
      return {
        error: {
          found: false,
          reason: 'ambiguous_name',
          hint: `"${a.name}" matches ${cands.length} credit unions. Re-call with cu_number.`,
          candidates: cands.slice(0, 15).map((c: any) => ({
            cu_number: c.cu_number, name: c.cu_name, city: c.city, state: c.state,
          })),
          source: SOURCE,
        },
      };
    }
    const full = await pg(
      ctx,
      `ncua_credit_unions?select=*&cu_number=eq.${exact.cu_number}&cycle_date=eq.${quarter}&limit=1`,
    );
    return { cu: full[0] };
  }
  const full = await pg(
    ctx,
    `ncua_credit_unions?select=*&cu_number=eq.${cands[0].cu_number}&cycle_date=eq.${quarter}&limit=1`,
  );
  return { cu: full[0] };
}

async function profile(ctx: Ctx, a: Record<string, unknown>) {
  const quarter = (a.quarter as string) || (await latestQuarter(ctx));
  if (!quarter) return notFound('no_data_loaded', 'The NCUA mirror is empty.');
  const { cu, error } = await pickCu(ctx, a, quarter);
  if (error) return error;

  const codes = Object.values(METRIC_CODES);
  const [vals, lbl, br, atm] = await Promise.all([
    pg(ctx, `ncua_cu_financials?select=account,value&cu_number=eq.${cu.cu_number}&cycle_date=eq.${quarter}&account=in.(${codes.join(',')})`),
    labels(ctx, codes),
    pgCount(ctx, `ncua_branches?select=cu_number&cu_number=eq.${cu.cu_number}`),
    pgCount(ctx, `ncua_atms?select=cu_number&cu_number=eq.${cu.cu_number}`),
  ]);
  const byCode = new Map(vals.map((v: any) => [v.account, Number(v.value)]));

  const financials: Record<string, unknown> = {};
  for (const [key, code] of Object.entries(METRIC_CODES)) {
    const has = byCode.has(code);
    financials[key] = {
      account: code,
      label: lbl[code] ?? null,
      value: has ? byCode.get(code) : null,
      // Spell out what a null means, per metric. Silence here is how "did not
      // have to report it" gets read as "earned nothing".
      ...(has ? {} : {
        not_reported: CONDITIONAL_METRICS.has(key)
          ? 'NCUA collects this only in certain circumstances (see label) — this credit union was not required to report it separately, which is not the same as the figure being zero.'
          : 'Not reported by this credit union for this quarter.',
      }),
    };
  }

  return {
    quarter,
    source: SOURCE,
    credit_union: {
      cu_number: cu.cu_number,
      name: cu.cu_name,
      city: cu.city,
      state: cu.state,
      charter_state: cu.charter_state,
      street: cu.street,
      zip_code: cu.zip_code,
      year_opened: cu.year_opened,
      peer_group: cu.peer_group,
      minority_depository_institution: cu.is_mdi,
      rssd: cu.rssd,
    },
    financials,
    branch_count: br,
    atm_count: atm,
  };
}

async function financials(ctx: Ctx, a: Record<string, unknown>) {
  const quarter = await latestQuarter(ctx);
  if (!quarter) return notFound('no_data_loaded', 'The NCUA mirror is empty.');
  const { cu, error } = await pickCu(ctx, a, quarter);
  if (error) return error;

  const code = metricCode(a.metric);

  if (code) {
    const rows = await pg(
      ctx,
      `ncua_cu_financials?select=cycle_date,value&cu_number=eq.${cu.cu_number}&account=eq.${enc(code)}&order=cycle_date.asc&limit=200`,
    );
    const lbl = await labels(ctx, [code]);
    if (!rows.length) {
      return notFound(
        'metric_not_reported',
        `${cu.cu_name} has no reported value for ${code} in the mirrored quarters. This pack mirrors the 197 accounts in NCUA's Financial Performance Report; ncua_account_lookup will confirm whether ${code} exists at all.`,
        { cu_number: cu.cu_number, name: cu.cu_name, account: code, label: lbl[code] ?? null },
      );
    }
    return {
      source: SOURCE,
      credit_union: { cu_number: cu.cu_number, name: cu.cu_name, state: cu.state },
      account: code,
      label: lbl[code] ?? null,
      count: rows.length,
      series: rows.map((r: any) => ({ quarter: r.cycle_date, value: Number(r.value) })),
    };
  }

  const rows = await pg(
    ctx,
    `ncua_cu_financials?select=account,value&cu_number=eq.${cu.cu_number}&cycle_date=eq.${quarter}&order=account.asc&limit=400`,
  );
  const lbl = await labels(ctx, rows.map((r: any) => r.account));
  return {
    quarter,
    source: SOURCE,
    credit_union: { cu_number: cu.cu_number, name: cu.cu_name, state: cu.state },
    count: rows.length,
    figures: rows.map((r: any) => ({
      account: r.account,
      label: lbl[r.account] ?? null,
      value: Number(r.value),
    })),
  };
}

async function rank(ctx: Ctx, a: Record<string, unknown>) {
  const quarter = (a.quarter as string) || (await latestQuarter(ctx));
  if (!quarter) return notFound('no_data_loaded', 'The NCUA mirror is empty.');
  const code = metricCode(a.metric) ?? METRIC_CODES.total_assets;
  const limit = clamp(a.limit, 20, 100);

  // With a state filter we must restrict to that state's charters first —
  // the financials table has no state column.
  let cuFilter = '';
  if (a.state) {
    const cus = await pgAll(
      ctx,
      `ncua_credit_unions?select=cu_number&cycle_date=eq.${quarter}&state=eq.${enc(String(a.state).toUpperCase())}`,
      'cu_number.asc',
    );
    if (!cus.length) {
      return notFound('no_credit_unions_in_state', `No credit unions on file in ${a.state} for ${quarter}.`, { quarter });
    }
    cuFilter = `&cu_number=in.(${cus.map((c: any) => c.cu_number).join(',')})`;
  }

  const rows = await pg(
    ctx,
    `ncua_cu_financials?select=cu_number,value&account=eq.${enc(code)}&cycle_date=eq.${quarter}${cuFilter}` +
      `&order=value.desc&limit=${limit}`,
  );
  if (!rows.length) {
    return notFound(
      'metric_not_reported',
      `No credit union reported ${code} for ${quarter}. Check the code with ncua_account_lookup.`,
      { account: code, quarter },
    );
  }

  const [names, lbl] = await Promise.all([
    pg(ctx, `ncua_credit_unions?select=cu_number,cu_name,city,state&cycle_date=eq.${quarter}&cu_number=in.(${rows.map((r: any) => r.cu_number).join(',')})`),
    labels(ctx, [code]),
  ]);
  const byCu = new Map(names.map((n: any) => [n.cu_number, n]));

  return {
    quarter,
    source: SOURCE,
    account: code,
    label: lbl[code] ?? null,
    state: (a.state as string) ?? null,
    count: rows.length,
    ranking: rows.map((r: any, i: number) => {
      const n: any = byCu.get(r.cu_number);
      return {
        rank: i + 1,
        cu_number: r.cu_number,
        name: n?.cu_name ?? null,
        city: n?.city ?? null,
        state: n?.state ?? null,
        value: Number(r.value),
      };
    }),
  };
}

async function compare(ctx: Ctx, a: Record<string, unknown>) {
  const quarter = await latestQuarter(ctx);
  if (!quarter) return notFound('no_data_loaded', 'The NCUA mirror is empty.');

  const wanted: Array<Record<string, unknown>> = [];
  if (Array.isArray(a.cu_numbers)) for (const n of a.cu_numbers) wanted.push({ cu_number: n });
  if (Array.isArray(a.names)) for (const n of a.names) wanted.push({ name: n });
  if (wanted.length < 2) {
    return notFound('need_two', 'Pass at least two credit unions via names or cu_numbers.');
  }

  const codes = Object.values(METRIC_CODES);
  const lbl = await labels(ctx, codes);
  const out: unknown[] = [];
  for (const w of wanted.slice(0, 5)) {
    const { cu, error } = await pickCu(ctx, w, quarter);
    if (error) { out.push({ requested: w, ...error }); continue; }
    const vals = await pg(
      ctx,
      `ncua_cu_financials?select=account,value&cu_number=eq.${cu.cu_number}&cycle_date=eq.${quarter}&account=in.(${codes.join(',')})`,
    );
    const byCode = new Map(vals.map((v: any) => [v.account, Number(v.value)]));
    const fin: Record<string, unknown> = {};
    for (const [key, code] of Object.entries(METRIC_CODES)) {
      fin[key] = byCode.has(code) ? byCode.get(code) : null;
    }
    out.push({
      cu_number: cu.cu_number, name: cu.cu_name, city: cu.city, state: cu.state, ...fin,
    });
  }

  return {
    quarter,
    source: SOURCE,
    metric_labels: Object.fromEntries(
      Object.entries(METRIC_CODES).map(([k, c]) => [k, { account: c, label: lbl[c] ?? null }]),
    ),
    credit_unions: out,
  };
}

async function accountLookup(ctx: Ctx, a: Record<string, unknown>) {
  const limit = clamp(a.limit, 15, 50);
  if (a.code) {
    const code = String(a.code).trim().toUpperCase();
    const rows = await pg(ctx, `ncua_account_codes?select=*&account=eq.${enc(code)}&limit=1`);
    if (!rows.length) {
      return notFound(
        'unknown_account_code',
        `NCUA's dictionary has no account "${code}". Codes look like ACCT_010; some are named outright (e.g. FOMMINORITYSTATUS). Try ncua_account_lookup({query: "..."}).`,
        { code },
      );
    }
    const r = rows[0];
    return {
      source: SOURCE,
      account: r.account,
      name: r.acct_name,
      description: r.acct_desc,
      reported_in: r.table_name,
      in_financial_performance_report: r.is_fpr,
      mirrored_values: r.is_fpr,
    };
  }
  if (!a.query) return notFound('no_criteria', 'Pass code or query.');

  const q = String(a.query).trim();
  let rows = await pg(
    ctx,
    `ncua_account_codes?select=account,acct_name,acct_desc,table_name,is_fpr&acct_name=ilike.*${enc(q)}*&order=is_fpr.desc,account.asc&limit=${limit}`,
  );
  if (!rows.length) {
    rows = await pg(
      ctx,
      `ncua_account_codes?select=account,acct_name,acct_desc,table_name,is_fpr&acct_desc=ilike.*${enc(q)}*&order=is_fpr.desc,account.asc&limit=${limit}`,
    );
  }
  if (!rows.length) {
    return notFound('no_matching_accounts', `Nothing in NCUA's 3,376-account dictionary matches "${q}".`, { query: q });
  }
  return {
    source: SOURCE,
    query: q,
    count: rows.length,
    accounts: rows.map((r: any) => ({
      account: r.account,
      name: r.acct_name,
      description: r.acct_desc ? String(r.acct_desc).slice(0, 400) : null,
      reported_in: r.table_name,
      in_financial_performance_report: r.is_fpr,
      mirrored_values: r.is_fpr,
    })),
  };
}

async function branches(ctx: Ctx, a: Record<string, unknown>) {
  const limit = clamp(a.limit, 25, 100);
  const filters: string[] = [];

  if (a.cu_number != null) filters.push(`cu_number=eq.${Number(a.cu_number)}`);
  else if (a.name) {
    const quarter = await latestQuarter(ctx);
    if (!quarter) return notFound('no_data_loaded', 'The NCUA mirror is empty.');
    const { cu, error } = await pickCu(ctx, a, quarter);
    if (error) return error;
    filters.push(`cu_number=eq.${cu.cu_number}`);
  }
  if (a.city) filters.push(`city=ilike.*${enc(String(a.city).trim())}*`);
  if (a.state) filters.push(`state=eq.${enc(String(a.state).trim().toUpperCase())}`);
  if (a.postal_code) filters.push(`postal_code=like.${enc(String(a.postal_code).trim())}*`);
  if (!filters.length) {
    return notFound('no_criteria', 'Pass a credit union (cu_number/name) or a location (city, state or postal_code).');
  }

  const q = `${filters.join('&')}&order=state.asc,city.asc&limit=${limit}`;
  const rows = await pg(ctx, `ncua_branches?select=cu_number,cu_name,site_name,site_type,main_office,address_1,city,state,postal_code,phone,hours,has_atm,drive_thru&${q}`);

  let atms: any[] = [];
  if (a.include_atms) {
    atms = await pg(ctx, `ncua_atms?select=cu_number,cu_name,site_name,address_1,city,state,postal_code&${q}`);
  }

  if (!rows.length && !atms.length) {
    return notFound(
      'no_locations',
      'No branch on file for those criteria. NCUA records physical addresses only — a credit union may still serve the area through shared branching or online.',
      { criteria: { city: a.city ?? null, state: a.state ?? null, postal_code: a.postal_code ?? null } },
    );
  }

  return {
    source: SOURCE,
    geocoding: 'none — NCUA publishes addresses without coordinates, so this is a text match on city/state/ZIP, not a distance search',
    count: rows.length,
    branches: rows,
    ...(a.include_atms ? { atm_count: atms.length, atms } : {}),
  };
}

async function industryTotals(ctx: Ctx, a: Record<string, unknown>) {
  const quarter = (a.quarter as string) || (await latestQuarter(ctx));
  if (!quarter) return notFound('no_data_loaded', 'The NCUA mirror is empty.');

  const cus = await pgAll(
    ctx,
    `ncua_credit_unions?select=cu_number&cycle_date=eq.${quarter}` +
      (a.state ? `&state=eq.${enc(String(a.state).toUpperCase())}` : ''),
    'cu_number.asc',
  );
  if (!cus.length) {
    return notFound('no_credit_unions', `No credit unions on file for ${quarter}${a.state ? ` in ${a.state}` : ''}.`, { quarter });
  }

  // Pull the two figures for the whole quarter and intersect in memory. Sending
  // 4,336 ids in an `in.(…)` would blow the URL length, and PostgREST has no
  // SUM without an RPC — but 4k rows a side is cheap.
  const inScope = new Set(cus.map((c: any) => c.cu_number));
  const [assetRows, memberRows] = await Promise.all([
    pgAll(ctx, `ncua_cu_financials?select=cu_number,value&account=eq.ACCT_010&cycle_date=eq.${quarter}`, 'cu_number.asc'),
    pgAll(ctx, `ncua_cu_financials?select=cu_number,value&account=eq.ACCT_083&cycle_date=eq.${quarter}`, 'cu_number.asc'),
  ]);
  const assets = assetRows.filter((r: any) => inScope.has(r.cu_number));
  const members = memberRows.filter((r: any) => inScope.has(r.cu_number));
  const sum = (rows: any[]) => rows.reduce((t, r) => t + Number(r.value || 0), 0);
  const totalAssets = sum(assets);
  const totalMembers = sum(members);

  return {
    quarter,
    source: SOURCE,
    scope: a.state ? String(a.state).toUpperCase() : 'United States',
    credit_unions: cus.length,
    total_assets: totalAssets,
    total_members: totalMembers,
    average_assets: cus.length ? Math.round(totalAssets / cus.length) : null,
    reporting: {
      assets_reported_by: assets.length,
      members_reported_by: members.length,
      note: 'Totals cover credit unions that reported the figure in this quarter; a credit union missing from a quarter has merged or liquidated rather than gone unreported.',
    },
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = args._supabaseUrl as string;
  const key = args._supabaseKey as string;
  if (!url || !key) throw new Error('ncua is not configured on this deployment — an operator must enable its data credentials.');
  delete args._supabaseUrl;
  delete args._supabaseKey;
  const ctx: Ctx = { url, key };

  switch (name) {
    case 'ncua_search_credit_unions': return searchCreditUnions(ctx, args);
    case 'ncua_credit_union_profile': return profile(ctx, args);
    case 'ncua_credit_union_financials': return financials(ctx, args);
    case 'ncua_rank_credit_unions': return rank(ctx, args);
    case 'ncua_compare_credit_unions': return compare(ctx, args);
    case 'ncua_account_lookup': return accountLookup(ctx, args);
    case 'ncua_branches': return branches(ctx, args);
    case 'ncua_industry_totals': return industryTotals(ctx, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
