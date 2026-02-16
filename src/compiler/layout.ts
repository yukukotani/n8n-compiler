/**
 * Node layout engine using dagre, matching n8n's tidy-up logic.
 *
 * The algorithm mirrors `useCanvasLayout.ts` in n8n's editor-ui:
 *   1. Build a dagre graph from IR nodes + edges (LR rankdir).
 *   2. Split into connected components via `dagre.graphlib.alg.components`.
 *   3. Layout each component independently.
 *   4. Stack components vertically using a TB dagre pass.
 *   5. Anchor the result so the top-left node sits at (0, 0).
 *
 * Constants are taken directly from n8n:
 *   - GRID_SIZE = 16
 *   - NODE_X_SPACING = GRID_SIZE * 8  (128)
 *   - NODE_Y_SPACING = GRID_SIZE * 6  (96)
 *   - SUBGRAPH_SPACING = GRID_SIZE * 8 (128)
 *   - DEFAULT_NODE_SIZE = [96, 96]
 */

import dagre from "@dagrejs/dagre";
import type { EdgeIR, NodeIR } from "./ir";

// ── n8n-compatible constants ──────────────────────────────────────────────────
const GRID_SIZE = 16;
const NODE_X_SPACING = GRID_SIZE * 8; // 128
const NODE_Y_SPACING = GRID_SIZE * 6; // 96
const SUBGRAPH_SPACING = GRID_SIZE * 8; // 128
const DEFAULT_NODE_WIDTH = GRID_SIZE * 6; // 96
const DEFAULT_NODE_HEIGHT = GRID_SIZE * 6; // 96

// ── Types ─────────────────────────────────────────────────────────────────────
type BoundingBox = { x: number; y: number; width: number; height: number };

export type NodePosition = { nodeKey: string; x: number; y: number };

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute tidy-up positions for all IR nodes, using the same dagre-based
 * approach as n8n's canvas layout.
 */
export function computeLayout(nodes: NodeIR[], edges: EdgeIR[]): NodePosition[] {
  if (nodes.length === 0) {
    return [];
  }

  // Build the parent dagre graph with all nodes & edges.
  const parentGraph = createParentGraph(nodes, edges);

  // Split into connected components (subgraphs).
  const components = dagre.graphlib.alg.components(parentGraph);

  const subgraphs = components.map((nodeIds: string[]) => {
    const subgraph = createSubGraph(nodeIds, parentGraph);
    dagre.layout(subgraph, { disableOptimalOrderHeuristic: true });
    return { graph: subgraph, boundingBox: boundingBoxFromGraph(subgraph) };
  });

  // Stack components vertically via a TB composite graph (same as n8n).
  const compositeGraph = createVerticalCompositeGraph(
    subgraphs.map(({ boundingBox }, index) => ({
      id: index.toString(),
      box: boundingBox,
    })),
  );
  dagre.layout(compositeGraph, { disableOptimalOrderHeuristic: true });

  // Collect positioned nodes across all subgraphs.
  const positionedNodes: { id: string; box: BoundingBox }[] = subgraphs.flatMap(
    ({ graph }, index) => {
      const compositeNode = compositeGraph.node(index.toString());
      const offset = {
        x: 0,
        y: compositeNode.y - compositeNode.height / 2,
      };

      return graph.nodes().map((nodeId: string) => {
        const { x, y, width, height } = graph.node(nodeId);
        return {
          id: nodeId,
          box: {
            x: x + offset.x - width / 2,
            y: y + offset.y - height / 2,
            width,
            height,
          },
        };
      });
    },
  );

  // Compute anchor offset so that the top-left of the bounding box maps to (0, 0).
  const allBoxes = positionedNodes.map((n) => n.box);
  const composite = compositeBoundingBox(allBoxes);

  return positionedNodes.map(({ id, box }) => ({
    nodeKey: id,
    x: snapToGrid(box.x - composite.x),
    y: snapToGrid(box.y - composite.y),
  }));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function createParentGraph(nodes: NodeIR[], edges: EdgeIR[]): dagre.graphlib.Graph {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));

  // We don't set a global graph layout config here because we'll create
  // per-component subgraphs with their own LR config (same as n8n).

  const nodeKeySet = new Set(nodes.map((n) => n.key));

  for (const node of nodes) {
    graph.setNode(node.key, {
      width: DEFAULT_NODE_WIDTH,
      height: DEFAULT_NODE_HEIGHT,
    });
  }

  for (const edge of edges) {
    // Skip loop-back edges for layout purposes (they create cycles).
    if (edge.kind === "loop-back") {
      continue;
    }
    if (nodeKeySet.has(edge.from) && nodeKeySet.has(edge.to)) {
      graph.setEdge(edge.from, edge.to);
    }
  }

  return graph;
}

function createSubGraph(nodeIds: string[], parent: dagre.graphlib.Graph): dagre.graphlib.Graph {
  const subGraph = new dagre.graphlib.Graph();
  subGraph.setGraph({
    rankdir: "LR",
    edgesep: NODE_Y_SPACING,
    nodesep: NODE_Y_SPACING,
    ranksep: NODE_X_SPACING,
  });
  subGraph.setDefaultEdgeLabel(() => ({}));

  const nodeIdSet = new Set(nodeIds);

  for (const nodeId of parent.nodes()) {
    if (nodeIdSet.has(nodeId)) {
      subGraph.setNode(nodeId, parent.node(nodeId));
    }
  }

  for (const edge of parent.edges()) {
    if (nodeIdSet.has(edge.v) && nodeIdSet.has(edge.w)) {
      subGraph.setEdge(edge.v, edge.w, parent.edge(edge));
    }
  }

  return subGraph;
}

function createVerticalCompositeGraph(
  items: Array<{ id: string; box: BoundingBox }>,
): dagre.graphlib.Graph {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: "TB",
    align: "UL",
    edgesep: SUBGRAPH_SPACING,
    nodesep: SUBGRAPH_SPACING,
    ranksep: SUBGRAPH_SPACING,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const { id, box } of items) {
    graph.setNode(id, { x: box.x, y: box.y, width: box.width, height: box.height });
  }

  for (let i = 0; i < items.length - 1; i++) {
    const current = items[i];
    const next = items[i + 1];
    if (current && next) {
      graph.setEdge(current.id, next.id);
    }
  }

  return graph;
}

function boundingBoxFromGraph(graph: dagre.graphlib.Graph): BoundingBox {
  const boxes = graph.nodes().map((nodeId: string) => {
    const node = graph.node(nodeId);
    return {
      x: node.x - node.width / 2,
      y: node.y - node.height / 2,
      width: node.width,
      height: node.height,
    };
  });
  return compositeBoundingBox(boxes);
}

function compositeBoundingBox(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
