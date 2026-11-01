import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { ExplainPanel } from "@/components/cockpit/explain-panel";
import { layoutDiagram } from "@/lib/cockpit/diagram-layout";
import type { ExplainStatus, Explanation } from "@/lib/cockpit/explore";

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

const overlap = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

test("layout ranks nodes, no overlap", () => {
  const layout = layoutDiagram(
    [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
      { id: "d", label: "D" },
    ],
    [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ],
  );
  const layer = (id: string) => layout.nodes.find((n) => n.id === id)?.layer;
  expect(layer("a")).toBe(0);
  expect(layer("b")).toBe(1);
  expect(layer("c")).toBe(1);
  expect(layer("d")).toBe(2);
  expect(layout.edges).toHaveLength(4);
  for (const [i, a] of layout.nodes.entries()) {
    for (const b of layout.nodes.slice(i + 1))
      expect(overlap(a, b)).toBe(false);
  }
});

test("cycle terminates", () => {
  const layout = layoutDiagram(
    [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
      { from: "a", to: "a" },
      { from: "a", to: "ghost" },
    ],
  );
  expect(layout.nodes).toHaveLength(3);
  expect(layout.edges).toHaveLength(3);
});

const explanation = (label: string): Explanation => ({
  summary: "Un résumé.",
  sections: [{ title: "Vue", text: "Texte." }],
  modules: [{ path: "src/", role: "code" }],
  diagram: {
    nodes: [
      { id: "a", label, kind: "service" },
      { id: "b", label: "B", kind: "db" },
    ],
    edges: [{ from: "a", to: "b", label: "uses" }],
  },
});

function mockFetch(status: ExplainStatus) {
  const fetchMock = mock(async (_url: string, _init?: RequestInit) => {
    return new Response(JSON.stringify(status), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function panel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ExplainPanel name="demo" />
    </QueryClientProvider>,
  );
}

test("<script> label renders literally as text", async () => {
  const evil = "<script>x()</script>";
  mockFetch({
    head: "a".repeat(40),
    promptVersion: 1,
    estimate: null,
    cached: {
      head: "a".repeat(40),
      generatedAt: 1,
      explanation: explanation(evil),
    },
    staleCached: null,
  });
  const { container, findByText } = panel();
  await findByText(evil);
  expect(container.querySelector("script")).toBeNull();
  expect(container.querySelector("svg")).not.toBeNull();
});

test("button shows estimate before POST and POST is not sent on render", async () => {
  const fetchMock = mockFetch({
    head: "b".repeat(40),
    promptVersion: 1,
    estimate: { inputTokens: 12345, maxOutputTokens: 2000 },
    cached: null,
    staleCached: {
      head: "c".repeat(40),
      generatedAt: 1,
      explanation: explanation("Old"),
    },
  });
  const { findByText, getByRole, getByText } = panel();
  await findByText(/12,345/);
  expect(getByRole("button", { name: "Regenerate" })).toBeTruthy();
  expect(getByText("stale")).toBeTruthy();
  const methods = fetchMock.mock.calls.map((c) => c[1]?.method ?? "GET");
  expect(methods).not.toContain("POST");
});
