import { type Context, Hono } from "hono";
import type { Complete } from "../triage";
import { createTtlCache } from "./cache";
import { type CiService, createCiService } from "./ci";
import { type CockpitService, createCockpitService } from "./collect";
import { type MachineService, createMachineService } from "./machine";
import { type RunnerControl, createRunnerControl } from "./runner-control";
import type { AttentionItem } from "./types";
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
  /** Runners and runs; without it the CI route answers 404. */
  ci?: CiService;
  /** Load, memory, disk and Docker; without it the machine route answers 404. */
  machine?: MachineService;
  /** Pause and resume of one runner; without it the POST answers 404. */
  control?: RunnerControl;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const EXPLAIN_POST = /^\/api\/cockpit\/projects\/[^/]+\/explain$/;
const RUNNER_POST = /^\/api\/cockpit\/runners\/[^/]+\/(pause|resume)$/;
const RUNNER_NAME = /^[\w.-]{1,64}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The cockpit's own Hono app. It never joins the main app, whose /api is reachable from the LAN and
 * from the app's proxy at 127.0.0.1; here every request must come from this machine, name this
 * machine in `Host` (DNS rebinding), and, when it is a page, come from one of the allowed origins.
 * GET only, except two POSTs (generate an explanation, which costs tokens; pause or resume a runner): they
 * must come from an allowed page Origin and carry no body, so they are simple requests that never need a preflight.
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
    const post = c.req.method === "POST" && (EXPLAIN_POST.test(c.req.path) || RUNNER_POST.test(c.req.path));
    if (c.req.method !== "GET" && !post) {
      c.header("Allow", EXPLAIN_POST.test(c.req.path) ? "GET, POST" : RUNNER_POST.test(c.req.path) ? "POST" : "GET");
      return c.json({ error: "method not allowed" }, 405);
    }
    if (post && origin === undefined) return c.json({ error: "forbidden" }, 403);
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

  app.get("/api/cockpit/ci", async (c) => (options.ci ? c.json(await options.ci.ci()) : c.json({ error: "not found" }, 404)));

  app.get("/api/cockpit/machine", async (c) => (options.machine ? c.json(await options.machine.facts()) : c.json({ error: "not found" }, 404)));

  app.post("/api/cockpit/runners/:name/:action", async (c) => {
    const length = c.req.header("content-length");
    if ((length !== undefined && length.trim() !== "0") || c.req.header("transfer-encoding") !== undefined) {
      return c.json({ error: "no body allowed" }, 400);
    }
    // The only query allowed is a single `force=1`.
    const query = new URL(c.req.url).searchParams;
    const keys = [...query.keys()];
    const force = query.getAll("force");
    if (keys.length > 0 && !(keys.length === 1 && force.length === 1 && force[0] === "1")) return c.json({ error: "bad query" }, 400);
    const name = c.req.param("name");
    const action = c.req.param("action") as "pause" | "resume";
    if (!options.control || !RUNNER_NAME.test(name)) return c.json({ error: "not found" }, 404);
    const outcome = await options.control.control(name, action, keys.length === 1);
    switch (outcome.kind) {
      case "ok":
        return c.json({ state: outcome.state });
      case "notfound":
        return c.json({ error: "not found" }, 404);
      case "busy":
        return c.json({ error: "busy" }, 409);
      case "locked":
        return c.json({ error: "another control is running" }, 429);
      case "rate":
        c.header("Retry-After", String(outcome.retryAfterSeconds));
        return c.json({ error: "too many controls this hour" }, 429);
      default:
        return c.json({ error: "the runner could not be controlled" }, 502);
    }
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

/** Attention lines from outside the projects: the usage budgets and a low disk. One failing source costs only itself. */
export function cockpitExtraAttention(usage: UsageService | undefined, machine: MachineService | undefined) {
  return async (): Promise<AttentionItem[]> => {
    const parts = await Promise.all(
      [usage?.attention(), machine?.attention()].map(async (p) => {
        try {
          return (await p) ?? [];
        } catch {
          return [];
        }
      }),
    );
    return parts.flat();
  };
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
  /** Runners, load and disk. Left out they are the real ones unless a `service` is injected; `null` turns them off. */
  ci?: CiService | null;
  machine?: MachineService | null;
  control?: RunnerControl | null;
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
  // One cache for the projects, the CI page and the machine, so a gh answer is read once for all of them.
  const real = options.service === undefined;
  const cache = createTtlCache();
  const machine = options.machine === undefined ? (real ? createMachineService({ cache }) : undefined) : (options.machine ?? undefined);
  const service = options.service ?? createCockpitService({ deps: { cache }, extraAttention: cockpitExtraAttention(usage, machine) });
  const ci =
    options.ci === undefined
      ? machine && real
        ? createCiService({
            cache, machine,
            projectRepos: async () => (await service.snapshot()).projects.map((p) => ({ name: p.name, repo: p.repo ?? null })),
          })
        : undefined
      : (options.ci ?? undefined);
  const control =
    options.control === undefined ? (ci && machine && real ? createRunnerControl({ ci, machine, cache }) : undefined) : (options.control ?? undefined);
  const app = createCockpitApp({
    getPort: () => bound,
    origins: options.origins,
    service,
    usage,
    ci,
    machine,
    control,
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
