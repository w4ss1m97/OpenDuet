import { type Context, Hono } from "hono";
import type { Complete } from "../triage";
import { type CockpitService, createCockpitService } from "./collect";
import { type ExplainService, createExplainService } from "./explain";
import { type ExploreService, createExploreService } from "./explore";
import { createUsageIngest } from "./usage-ingest";
import { createUsageConfigSource } from "./usage-prices";
import { type UsageService, createUsageService } from "./usage-service";
import { loadCockpitProjects, PROJECTS_FILE } from "./projects-file";

/** What Bun tells us about the peer; the listener passes it in, a test can pass its own. */
type Bindings = { ip?: { address: string } | null };

export type CockpitAppOptions = {
  /** The port actually bound, read at each request (a listener on port 0 only learns it after it starts). */
  getPort: () => number;
  /** Origins whose pages may read the answers: the app's own, plus the desktop shell's. */
  origins: ReadonlySet<string>;
  service: CockpitService;
  /** Facts about a project's committed tree; without it the explore and explain routes answer 404. */
  explore?: ExploreService;
  /** The model explanation; without it the POST answers 503. */
  explain?: ExplainService;
  /** Token usage from the Claude transcripts; without it the usage routes answer 404. */
  usage?: UsageService;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const EXPLAIN_POST = /^\/api\/cockpit\/projects\/[^/]+\/explain$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The cockpit's own Hono app. It never joins the main app, whose /api is reachable from the LAN and
 * from the app's proxy at 127.0.0.1; here every request must come from this machine, name this
 * machine in `Host` (DNS rebinding), and, when it is a page, come from one of the allowed origins.
 * GET only, except one POST (generate an explanation, which costs tokens): that one must come from an
 * allowed page Origin and carry no body, so it is a simple request that never needs a preflight.
 */
export function createCockpitApp(options: CockpitAppOptions) {
  const app = new Hono<{ Bindings: Bindings }>();

  app.use("*", async (c, next) => {
    const port = options.getPort();
    const host = c.req.header("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return c.json({ error: "forbidden" }, 403);
    const peer = c.env?.ip?.address;
    if (!peer || !LOOPBACK.has(peer)) return c.json({ error: "forbidden" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !options.origins.has(origin)) return c.json({ error: "forbidden" }, 403);
    const explainPost = c.req.method === "POST" && EXPLAIN_POST.test(c.req.path);
    if (c.req.method !== "GET" && !explainPost) {
      c.header("Allow", EXPLAIN_POST.test(c.req.path) ? "GET, POST" : "GET");
      return c.json({ error: "method not allowed" }, 405);
    }
    if (explainPost && origin === undefined) return c.json({ error: "forbidden" }, 403);
    c.header("Cache-Control", "no-store");
    if (origin !== undefined) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
    }
    await next();
  });

  app.get("/api/cockpit/projects", async (c) => c.json(await options.service.snapshot()));

  app.get("/api/cockpit/projects/:name", async (c) => {
    const found = await options.service.project(c.req.param("name"));
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/cockpit/projects/:name/explore", async (c) => {
    const found = await options.explore?.explore(c.req.param("name"));
    return found ? c.json(found.facts) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/cockpit/projects/:name/explain", async (c) => {
    const found = await options.explore?.explore(c.req.param("name"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (!options.explain) return c.json({ error: "unavailable" }, 503);
    return c.json(await options.explain.status(found));
  });

  app.post("/api/cockpit/projects/:name/explain", async (c) => {
    const length = c.req.header("content-length");
    if ((length !== undefined && length.trim() !== "0") || c.req.header("transfer-encoding") !== undefined) {
      return c.json({ error: "no body allowed" }, 400);
    }
    const wanted = c.req.query("head");
    if (wanted === undefined || !HEAD_SHA.test(wanted)) return c.json({ error: "head is required" }, 400);
    const found = await options.explore?.explore(c.req.param("name"));
    if (!found) return c.json({ error: "not found" }, 404);
    if (found.facts.head !== wanted) return c.json({ error: "head changed", head: found.facts.head }, 409);
    if (!options.explain) return c.json({ error: "unavailable" }, 503);
    const outcome = await options.explain.generate(found, wanted);
    switch (outcome.kind) {
      case "ok":
        return c.json(outcome.result);
      case "busy":
        return c.json({ error: "busy" }, 429);
      case "rate":
        c.header("Retry-After", String(outcome.retryAfterSeconds));
        return c.json({ error: "too many explanations this hour" }, 429);
      case "unavailable":
        return c.json({ error: "unavailable" }, 503);
      default:
        return c.json({ error: "the model could not explain this project" }, 502);
    }
  });

  // A repeated query parameter is read as an empty (invalid) one rather than guessing which to use.
  const param = (c: Context, name: string) => {
    const values = c.req.queries(name);
    return values === undefined ? undefined : values.length === 1 ? values[0] : "";
  };

  app.get("/api/cockpit/usage", async (c) => {
    if (!options.usage) return c.json({ error: "not found" }, 404);
    const out = await options.usage.summary(param(c, "from"), param(c, "to"));
    return out.ok ? c.json(out.body) : c.json({ error: out.error }, 400);
  });

  app.get("/api/cockpit/usage/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const found = options.usage && SESSION_ID.test(id) ? await options.usage.session(id) : null;
    return found ? c.json(found) : c.json({ error: "not found" }, 404);
  });

  app.get("/api/cockpit/usage/budgets", async (c) => (options.usage ? c.json(await options.usage.budgets()) : c.json({ error: "not found" }, 404)));

  app.get("/api/cockpit/usage/advisor", async (c) => (options.usage ? c.json(await options.usage.advisor()) : c.json({ error: "not found" }, 404)));

  app.get("/api/cockpit/usage/export.csv", async (c) => {
    if (!options.usage) return c.json({ error: "not found" }, 404);
    const out = await options.usage.csv(param(c, "view"), param(c, "from"), param(c, "to"));
    if (!out.ok) return c.json({ error: out.error }, 400);
    return c.body(out.text, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${out.filename}"`,
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

/** Seconds a connection may stay silent: longer than the 120 s model call, within Bun's 255 s cap. */
export const COCKPIT_IDLE_TIMEOUT_S = 150;

/** Starts the cockpit on 127.0.0.1 only, whatever OPENBOT_HOST says. */
export function startCockpitServer(options: {
  port: number;
  origins: ReadonlySet<string>;
  service?: CockpitService;
  explore?: ExploreService;
  /** The model that explains projects; without a completer the explain POST answers 503. */
  explain?: { complete?: Complete; dir?: string };
  /**
   * Token usage. Left out, it is the real one (this Mac's transcripts and ~/.config/openduet/cockpit) unless a
   * `service` is injected, which is how tests run without touching the machine; `null` turns it off.
   */
  usage?: UsageService | null;
}) {
  let bound = options.port;
  const usage =
    options.usage === undefined && options.service === undefined
      ? createUsageService({
          ingest: createUsageIngest(),
          config: createUsageConfigSource(),
          listProjects: () => loadCockpitProjects({ file: PROJECTS_FILE }),
        })
      : (options.usage ?? undefined);
  const app = createCockpitApp({
    getPort: () => bound,
    origins: options.origins,
    service: options.service ?? createCockpitService({ extraAttention: usage ? () => usage.attention() : undefined }),
    usage,
    explore: options.explore ?? createExploreService(),
    explain: createExplainService({ complete: options.explain?.complete, dir: options.explain?.dir }),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: COCKPIT_IDLE_TIMEOUT_S,
    fetch: (request, srv) => app.fetch(request, { ip: srv.requestIP(request) }),
  });
  bound = server.port ?? options.port;
  if (usage) {
    // The timer is unref'd, so it never keeps the process alive; stopping the listener stops it too.
    const stopPolling = usage.start();
    const stopServer = server.stop.bind(server);
    server.stop = (force?: boolean) => {
      stopPolling();
      return stopServer(force);
    };
  }
  return server;
}
