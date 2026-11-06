import { type Context, Hono } from "hono";
import type { Complete } from "../triage";
import { createTtlCache } from "./cache";
import { type CiService, createCiService } from "./ci";
import { type CockpitService, createCockpitService } from "./collect";
import { createCockpitConfigSource } from "./cockpit-config";
import { type MachineService, createMachineService } from "./machine";
import { createNotifier } from "./notify";
import { type QualityService, createQualityService } from "./quality-service";
import { createQualityStore } from "./quality-store";
import { REMINDER_ID, type RemindersService, createRemindersService } from "./reminders";
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
  /** Quality scans and findings; without it the quality routes answer 404. */
  quality?: QualityService;
  /** Reminders and notifications; without it the reminder routes answer 404. */
  reminders?: RemindersService;
  /** Milliseconds clock for the write limits; tests pass their own. */
  now?: () => number;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const EXPLAIN_POST = /^\/api\/cockpit\/projects\/[^/]+\/explain$/;
const RUNNER_POST = /^\/api\/cockpit\/runners\/[^/]+\/(pause|resume)$/;
/**
 * Every write the cockpit accepts, and nothing else: a body-less simple POST with its arguments in the query string.
 * One list, one guard (below): a new write is added here or it answers 405.
 */
const WRITES: Array<{ re: RegExp; allow: string }> = [
  { re: EXPLAIN_POST, allow: "GET, POST" },
  { re: RUNNER_POST, allow: "POST" },
  { re: /^\/api\/cockpit\/quality\/scan$/, allow: "POST" },
  { re: /^\/api\/cockpit\/quality\/[^/]+\/dismiss$/, allow: "POST" },
  { re: /^\/api\/cockpit\/reminders$/, allow: "GET, POST" },
  { re: /^\/api\/cockpit\/reminders\/[^/]+\/(done|snooze|delete)$/, allow: "POST" },
  { re: /^\/api\/cockpit\/notifications\/test$/, allow: "POST" },
];
const WRITES_PER_MINUTE = 30;
const SCAN_ALL_EVERY_S = 300;
const PROJECT_KEY = /^[0-9a-f]{16}$/;
const ACTION_ID = /^\/api\/cockpit\/reminders\/[^/]+\/(done|snooze|delete)$/;
const RUNNER_NAME = /^[\w.-]{1,64}$/;
const HEAD_SHA = /^[0-9a-f]{40}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The cockpit's own Hono app. It never joins the main app, whose /api is reachable from the LAN and
 * from the app's proxy at 127.0.0.1; here every request must come from this machine, name this
 * machine in `Host` (DNS rebinding), and, when it is a page, come from one of the allowed origins.
 * GET only, except the POSTs listed in WRITES (explanations, runner control, scans, reminders): they must come from
 * an allowed page Origin, carry no body and no repeated parameter, and stay under 30 a minute, so they are simple
 * requests that never need a preflight.
 */
export function createCockpitApp(options: CockpitAppOptions) {
  const app = new Hono<{ Bindings: Bindings }>();
  const clock = options.now ?? Date.now;
  const writeTimes: number[] = [];
  let lastScanAll = 0;

  app.use("*", async (c, next) => {
    const port = options.getPort();
    const host = c.req.header("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return c.json({ error: "forbidden" }, 403);
    const peer = c.env?.ip?.address;
    if (!peer || !LOOPBACK.has(peer)) return c.json({ error: "forbidden" }, 403);
    const origin = c.req.header("origin");
    if (origin !== undefined && !options.origins.has(origin)) return c.json({ error: "forbidden" }, 403);
    const write = WRITES.find((w) => w.re.test(c.req.path));
    const post = c.req.method === "POST" && write !== undefined;
    if (c.req.method !== "GET" && !post) {
      c.header("Allow", write?.allow ?? "GET");
      return c.json({ error: "method not allowed" }, 405);
    }
    if (post) {
      if (origin === undefined) return c.json({ error: "forbidden" }, 403);
      const length = c.req.header("content-length");
      if ((length !== undefined && length.trim() !== "0") || c.req.header("transfer-encoding") !== undefined) {
        return c.json({ error: "no body allowed" }, 400);
      }
      const names = [...new URL(c.req.url).searchParams.keys()];
      if (new Set(names).size !== names.length) return c.json({ error: "bad query" }, 400);
      const nowMs = clock();
      while (writeTimes.length > 0 && nowMs - writeTimes[0]! >= 60_000) writeTimes.shift();
      if (writeTimes.length >= WRITES_PER_MINUTE) {
        c.header("Retry-After", String(Math.max(1, Math.ceil((writeTimes[0]! + 60_000 - nowMs) / 1000))));
        return c.json({ error: "too many writes" }, 429);
      }
      writeTimes.push(nowMs);
    }
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

  const notFound = (c: Context) => c.json({ error: "not found" }, 404);

  app.get("/api/cockpit/quality", async (c) => (options.quality ? c.json(await options.quality.summary()) : notFound(c)));

  app.get("/api/cockpit/quality/:name", async (c) => {
    const found = await options.quality?.detail(c.req.param("name"));
    return found ? c.json(found) : notFound(c);
  });

  app.post("/api/cockpit/quality/scan", async (c) => {
    if (!options.quality) return notFound(c);
    const target = param(c, "project");
    if (target === undefined || target === "" || target.length > 100) return c.json({ error: "project is required" }, 400);
    if (target === "all") {
      const waited = clock() / 1000 - lastScanAll;
      if (waited < SCAN_ALL_EVERY_S) {
        c.header("Retry-After", String(Math.ceil(SCAN_ALL_EVERY_S - waited)));
        return c.json({ error: "scan of all projects asked too soon" }, 429);
      }
    }
    const out = await options.quality.requestScan(target);
    if (!out.accepted) return notFound(c);
    if (target === "all") lastScanAll = clock() / 1000;
    return c.json({ queued: out.queued }, 202);
  });

  app.post("/api/cockpit/quality/:name/dismiss", async (c) => {
    if (!options.quality) return notFound(c);
    const key = param(c, "key");
    if (key === undefined || !PROJECT_KEY.test(key)) return c.json({ error: "key must be 16 hex characters" }, 400);
    const out = await options.quality.dismiss(c.req.param("name"), key);
    return out.ok ? c.json({ until: out.until }) : notFound(c);
  });

  app.get("/api/cockpit/reminders", async (c) => (options.reminders ? c.json(await options.reminders.list()) : notFound(c)));

  app.post("/api/cockpit/reminders", async (c) => {
    if (!options.reminders) return notFound(c);
    const out = await options.reminders.add({ text: param(c, "text"), due: param(c, "due"), project: param(c, "project"), repeat: param(c, "repeat") });
    if (out.ok) return c.json(out.item, 201);
    return c.json({ error: out.error }, out.kind === "full" ? 409 : 400);
  });

  app.post("/api/cockpit/reminders/:id/:action", async (c) => {
    if (!options.reminders) return notFound(c);
    const id = c.req.param("id");
    if (!REMINDER_ID.test(id)) return c.json({ error: "bad id" }, 400);
    const action = ACTION_ID.exec(c.req.path)![1] as "done" | "snooze" | "delete";
    const rawUntil = param(c, "until");
    if (rawUntil !== undefined && !/^\d{1,11}$/.test(rawUntil)) return c.json({ error: "until must be epoch seconds" }, 400);
    const out = await options.reminders.act(id, action, rawUntil === undefined ? undefined : Number(rawUntil));
    if (out.ok) return c.json({ ok: true });
    return out.kind === "notfound" ? notFound(c) : c.json({ error: out.error }, 400);
  });

  app.post("/api/cockpit/notifications/test", async (c) => {
    if (!options.reminders) return notFound(c);
    const out = await options.reminders.testNotification();
    if (out.kind === "ok") return c.json({ sent: true });
    if (out.kind === "rate") {
      c.header("Retry-After", String(out.retryAfterSeconds));
      return c.json({ error: "one test a minute" }, 429);
    }
    return c.json({ error: "the notification could not be sent" }, 502);
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

/** Attention lines from outside the projects: the usage budgets, a low disk, the quality high findings. One failing source costs only itself. */
export function cockpitExtraAttention(usage: UsageService | undefined, machine: MachineService | undefined, quality?: QualityService) {
  const qualityLines = async (): Promise<AttentionItem[]> =>
    ((await quality?.summary())?.projects ?? []).flatMap((p) =>
      p.high.map((f) => ({ project: p.name, severity: "high" as const, message: f.text, link: `/cockpit/quality/${p.name}` })),
    );
  return async (): Promise<AttentionItem[]> => {
    const parts = await Promise.all(
      [usage?.attention(), machine?.attention(), quality ? qualityLines() : undefined].map(async (p) => {
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
  /** Quality scans and reminders. Left out they are the real ones unless a `service` is injected; `null` turns them off. */
  quality?: QualityService | null;
  reminders?: RemindersService | null;
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
  const settings = createCockpitConfigSource();
  const listProjects = () => loadCockpitProjects({ file: PROJECTS_FILE });
  const quality =
    options.quality === undefined
      ? real ? createQualityService({ store: createQualityStore(), listProjects, config: () => settings.quality() }) : undefined
      : (options.quality ?? undefined);
  const service = options.service ?? createCockpitService({ deps: { cache }, extraAttention: cockpitExtraAttention(usage, machine, quality) });
  const reminders =
    options.reminders === undefined
      ? real
        ? createRemindersService({
            config: () => settings.get(), snapshot: () => service.snapshot(), listProjects, notifier: createNotifier(),
            budgets: usage ? async () => (await usage.budgets()).budgets : undefined,
            quality: quality ? () => quality.summary() : undefined,
          })
        : undefined
      : (options.reminders ?? undefined);
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
    quality,
    reminders,
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
  // The timers are unref'd, so they never keep the process alive; stopping the listener stops them too.
  const stops = [usage?.start(), quality?.start(), reminders?.start()].filter((stop): stop is () => void => stop !== undefined);
  if (stops.length > 0) {
    const stopServer = server.stop.bind(server);
    server.stop = (force?: boolean) => {
      for (const stop of stops) stop();
      return stopServer(force);
    };
  }
  return server;
}
