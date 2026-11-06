/*
 * Layered layout for the explanation diagram. Pure: nodes and edges in, boxes and lines out.
 * Each node sits in a layer one deeper than its deepest parent; edges that would close a cycle
 * are ignored for ranking (found by a depth-first walk), so any graph terminates.
 */

export type LayoutNode = { id: string; label: string };
export type LayoutEdge = { from: string; to: string; label?: string };

export type PlacedNode = {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
};

export type PlacedEdge = {
  from: string;
  to: string;
  label: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

export type Layout = {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
};

const BOX_W = 160;
const BOX_H = 44;
const GAP_X = 32;
const GAP_Y = 64;
const PAD = 16;

export function layoutDiagram(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Layout {
  const ids = new Set<string>();
  const unique = nodes.filter((n) => {
    if (ids.has(n.id)) return false;
    ids.add(n.id);
    return true;
  });
  const valid = edges.filter(
    (e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to,
  );

  // Drop back edges so ranking is over a DAG.
  const out = new Map<string, string[]>();
  for (const n of unique) out.set(n.id, []);
  for (const e of valid) out.get(e.from)?.push(e.to);
  const state = new Map<string, 1 | 2>();
  const back = new Set<string>();
  for (const root of unique) {
    if (state.has(root.id)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: root.id, i: 0 }];
    state.set(root.id, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const next = out.get(top.id)?.[top.i++];
      if (next === undefined) {
        state.set(top.id, 2);
        stack.pop();
      } else if (state.get(next) === 1) {
        back.add(`${top.id}\u0000${next}`);
      } else if (!state.has(next)) {
        state.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }
  const dag = valid.filter((e) => !back.has(`${e.from}\u0000${e.to}`));

  // Longest-path layering, in topological order.
  const layer = new Map<string, number>(unique.map((n) => [n.id, 0]));
  const indegree = new Map<string, number>(unique.map((n) => [n.id, 0]));
  for (const e of dag) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const queue = unique.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift() as string;
    for (const e of dag) {
      if (e.from !== id) continue;
      layer.set(e.to, Math.max(layer.get(e.to) ?? 0, (layer.get(id) ?? 0) + 1));
      const left = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, left);
      if (left === 0) queue.push(e.to);
    }
  }

  const rows = new Map<number, LayoutNode[]>();
  for (const n of unique) {
    const l = layer.get(n.id) ?? 0;
    rows.set(l, [...(rows.get(l) ?? []), n]);
  }
  const widest = Math.max(1, ...[...rows.values()].map((r) => r.length));
  const width = PAD * 2 + widest * BOX_W + (widest - 1) * GAP_X;
  const placed = new Map<string, PlacedNode>();
  for (const [l, row] of rows) {
    const rowW = row.length * BOX_W + (row.length - 1) * GAP_X;
    const left = (width - rowW) / 2;
    row.forEach((n, i) => {
      placed.set(n.id, {
        id: n.id,
        label: n.label,
        x: left + i * (BOX_W + GAP_X),
        y: PAD + l * (BOX_H + GAP_Y),
        width: BOX_W,
        height: BOX_H,
        layer: l,
      });
    });
  }

  const lines: PlacedEdge[] = [];
  for (const e of valid) {
    const a = placed.get(e.from);
    const b = placed.get(e.to);
    if (!a || !b) continue;
    const down = b.layer >= a.layer;
    lines.push({
      from: e.from,
      to: e.to,
      label: e.label ?? "",
      x1: a.x + a.width / 2,
      y1: down ? a.y + a.height : a.y,
      x2: b.x + b.width / 2,
      y2: down ? b.y : b.y + b.height,
    });
  }
  const layers = rows.size;
  return {
    nodes: [...placed.values()],
    edges: lines,
    width,
    height:
      PAD * 2 + Math.max(1, layers) * BOX_H + Math.max(0, layers - 1) * GAP_Y,
  };
}
