import { Hono } from "hono";
import { type CockpitService, createCockpitService } from "./collect";

/** What Bun tells us about the peer; the listener passes it in, a test can pass its own. */
type Bindings = { ip?: { address: string } | null };

export type CockpitAppOptions = {
  /** The port actually bound, read at each request (a listener on port 0 only learns it after it starts). */
  getPort: () => number;
  /** Origins whose pages may read the answers: the app's own, plus the desktop shell's. */
  origins: ReadonlySet<string>;
  service: CockpitService;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * The cockpit's own Hono app. It never joins the main app, whose /api is reachable from the LAN and
 * from the app's proxy at 127.0.0.1; here every request must come from this machine, name this
 * machine in `Host` (DNS rebinding), and, when it is a page, come from one of the allowed origins.
 * GET only.
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
    if (c.req.method !== "GET") {
      c.header("Allow", "GET");
      return c.json({ error: "method not allowed" }, 405);
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

  app.notFound((c) => c.json({ error: "not found" }, 404));
  return app;
}

/** Starts the cockpit on 127.0.0.1 only, whatever OPENBOT_HOST says. */
export function startCockpitServer(options: {
  port: number;
  origins: ReadonlySet<string>;
  service?: CockpitService;
}) {
  let bound = options.port;
  const app = createCockpitApp({
    getPort: () => bound,
    origins: options.origins,
    service: options.service ?? createCockpitService(),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    fetch: (request, srv) => app.fetch(request, { ip: srv.requestIP(request) }),
  });
  bound = server.port ?? options.port;
  return server;
}
