import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { CockpitService } from "../src/openduet/cockpit/collect";
import { createCockpitApp, startCockpitServer } from "../src/openduet/cockpit/server";
import type { ProjectData } from "../src/openduet/cockpit/types";
import { testEnvironment } from "./support/environment";

const PORT = 3002;
const ORIGINS = new Set(["http://localhost:3010", "tauri://localhost"]);
const LOCAL = { ip: { address: "127.0.0.1" } };

const demo: ProjectData = { name: "My Project", path: "~/demo", error: null };
const item = { project: "My Project", severity: "low" as const, message: "m", link: null };
const service: CockpitService = {
  snapshot: async () => ({ projects: [demo], attention: [item], names: ["My Project"], generatedAt: 123 }),
  project: async (name) => (name === "My Project" ? { project: demo, attention: [item] } : null),
};
const app = createCockpitApp({ getPort: () => PORT, origins: ORIGINS, service });

const get = (path: string, headers: Record<string, string> = {}, env: unknown = LOCAL, method = "GET") =>
  app.request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, env as object);

describe("cockpit routes", () => {
  test("GET /api/cockpit/projects answers the snapshot, uncached", async () => {
    const res = await get("/api/cockpit/projects");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toEqual({ projects: [demo], attention: [item], names: ["My Project"], generatedAt: 123 });
  });

  test("GET /api/cockpit/projects/:name answers one project and decodes the name", async () => {
    const res = await get("/api/cockpit/projects/My%20Project");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ project: demo, attention: [item] });
  });

  test("an unknown project is 404", async () => {
    expect((await get("/api/cockpit/projects/nope")).status).toBe(404);
  });

  test("an unknown path is 404", async () => {
    expect((await get("/api/other")).status).toBe(404);
    expect((await get("/")).status).toBe(404);
  });

  test("localhost with the right port is accepted", async () => {
    expect((await get("/api/cockpit/projects", { Host: `localhost:${PORT}` })).status).toBe(200);
  });

  test("a LAN or foreign Host is 403 (DNS rebinding, OPENBOT_HOST)", async () => {
    for (const host of ["192.168.1.106:3002", "evil.example:3002", "evil.example", "127.0.0.1:3001", "localhost", "127.0.0.1.evil.example:3002"]) {
      const res = await get("/api/cockpit/projects", { Host: host });
      expect(res.status).toBe(403);
    }
  });

  test("a caller that is not loopback, or unknown, is 403", async () => {
    expect((await get("/api/cockpit/projects", {}, { ip: { address: "192.168.1.50" } })).status).toBe(403);
    expect((await get("/api/cockpit/projects", {}, {})).status).toBe(403);
    expect((await get("/api/cockpit/projects", {}, { ip: { address: "::1" } })).status).toBe(200);
    expect((await get("/api/cockpit/projects", {}, { ip: { address: "::ffff:127.0.0.1" } })).status).toBe(200);
  });

  test("a foreign Origin is 403 with no CORS header", async () => {
    for (const origin of ["https://evil.example", "null", "http://localhost:3999"]) {
      const res = await get("/api/cockpit/projects", { Origin: origin });
      expect(res.status).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("an allowed Origin is echoed, never *", async () => {
    for (const origin of ["http://localhost:3010", "tauri://localhost"]) {
      const res = await get("/api/cockpit/projects", { Origin: origin });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toContain("Origin");
    }
  });

  test("anything but GET is 405", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await get("/api/cockpit/projects", {}, LOCAL, method);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
  });

  test("a foreign Origin on a POST is 403, not 405", async () => {
    expect((await get("/api/cockpit/projects", { Origin: "https://evil.example" }, LOCAL, "POST")).status).toBe(403);
  });
});

describe("cockpit listener", () => {
  const servers: Array<{ stop(force?: boolean): unknown }> = [];
  afterAll(() => {
    for (const s of servers) s.stop(true);
  });

  test("binds 127.0.0.1 only and answers there", async () => {
    const server = startCockpitServer({ port: 0, origins: ORIGINS, service });
    servers.push(server);
    expect(server.hostname).toBe("127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${server.port}/api/cockpit/projects`);
    expect(res.status).toBe(200);
    expect((await res.json()).names).toEqual(["My Project"]);
    const rebound = await fetch(`http://127.0.0.1:${server.port}/api/cockpit/projects`, { headers: { Host: "evil.example" } });
    expect(rebound.status).toBe(403);
  });
});

describe("main app", () => {
  test("does not serve the cockpit", async () => {
    const main = createApp(loadConfig(testEnvironment()));
    const res = await main.request("http://127.0.0.1:3001/api/cockpit/projects");
    expect(res.status).toBe(404);
  });
});
