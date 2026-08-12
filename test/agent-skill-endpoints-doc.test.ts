/**
 * @fileoverview Static guard: every endpoint the packaged agent skill documents
 * still exists in the routes it is documenting.
 *
 * `skills/codeman/reference/endpoints.md` is injected into cases and read by agents
 * driving Codeman over HTTP. Nothing tied it to the server, so renaming or dropping a
 * route left the skill confidently telling agents to call a 404. This parses the
 * `METHOD /api/...` pairs out of the doc and matches them against the `app.<method>()`
 * registrations in src/web/routes/*.ts plus src/web/server.ts (which registers `/api/events`
 * and `/api/events/subscribe` directly). Fastify generics on the registration call are
 * tolerated, since approval-routes.ts uses them.
 *
 * Precision over recall on purpose: only a bare uppercase verb followed by an
 * `/api/...` path counts, so prose that merely mentions a path (the `.../sessions/null`
 * jq-pitfall example) is ignored, and a spuriously failing guard does not get deleted
 * by the next person. `/api/v1` is a URL-rewrite alias (server.ts), so the version
 * segment is dropped before matching, and param NAMES are normalized away since the
 * doc's `:id` need not match a route's `:sessionId`.
 *
 * Port: N/A (pure static analysis).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DOC_PATH = join(HERE, '../skills/codeman/reference/endpoints.md');
const ROUTES_DIR = join(HERE, '../src/web/routes');
/** `/api/events` and `/api/events/subscribe` are registered here, not in routes/. */
const SERVER_PATH = join(HERE, '../src/web/server.ts');

/** `METHOD /api/<path>`, stopping before a query string, backtick or prose. */
const DOC_ENDPOINT = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/(api\/[A-Za-z0-9_:/-]+)/g;
/**
 * `app.get('/api/…'`, where the path may sit on its own line (case-routes.ts,
 * file-routes.ts) and the call may carry a Fastify generic
 * (`app.post<{ Params: { id: string } }>('/api/approvals/:id/answer'`, approval-routes.ts).
 * The generic is matched non-greedily up to the `(` so a `<…>` containing braces or
 * nested generics still lands on the path argument.
 */
const ROUTE_REGISTRATION = /app\.(get|post|put|patch|delete)(?:<[\s\S]*?>)?\(\s*'([^']+)'/g;

/**
 * Strip the `/api/v1` alias and replace param names with a placeholder, so
 * `GET /api/v1/sessions/:id` and `app.get('/api/sessions/:sessionId')` compare equal.
 */
function normalize(method: string, path: string): string {
  const withoutVersion = path.replace(/^\/api\/v1\//, '/api/');
  const params = withoutVersion.replace(/\/:[^/]+/g, '/:p').replace(/\/$/, '');
  return `${method.toUpperCase()} ${params}`;
}

function documentedEndpoints(): string[] {
  const markdown = readFileSync(DOC_PATH, 'utf-8');
  const found = new Set<string>();
  for (const match of markdown.matchAll(DOC_ENDPOINT)) {
    found.add(normalize(match[1], `/${match[2]}`));
  }
  return [...found].sort();
}

function registeredRoutes(): Set<string> {
  const registered = new Set<string>();
  const sources = readdirSync(ROUTES_DIR)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(ROUTES_DIR, file));
  // Not every route lives in routes/: the SSE stream and its subscribe companion are
  // registered directly on the server (`this.app.get('/api/events')`), and the doc
  // documents them, so scanning only routes/ reported real endpoints as missing.
  sources.push(SERVER_PATH);
  for (const source of sources.map((path) => readFileSync(path, 'utf-8'))) {
    for (const match of source.matchAll(ROUTE_REGISTRATION)) {
      if (!match[2].startsWith('/api/')) continue;
      registered.add(normalize(match[1], match[2]));
    }
  }
  return registered;
}

describe('skills/codeman/reference/endpoints.md', () => {
  it('parses a plausible number of endpoints out of the doc', () => {
    // A parser that silently matches nothing would make the real assertion below
    // pass vacuously forever.
    const documented = documentedEndpoints();
    expect(documented.length).toBeGreaterThanOrEqual(10);
    expect(documented).toContain('POST /api/quick-start');
    expect(documented).toContain('GET /api/sessions/:p/wait');
  });

  it('finds the route registrations it matches against', () => {
    const registered = registeredRoutes();
    expect(registered.size).toBeGreaterThan(100);
    expect(registered.has('GET /api/status')).toBe(true);
  });

  it('documents only endpoints that are actually registered', () => {
    const registered = registeredRoutes();
    const missing = documentedEndpoints().filter((endpoint) => !registered.has(endpoint));
    expect(missing).toEqual([]);
  });
});
