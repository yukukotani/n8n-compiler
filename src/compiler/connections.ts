import type { EdgeIR } from "./ir";

type N8nConnectionItem = {
  node: string;
  type: "main";
  index: number;
};

type N8nNodeConnections = {
  main: N8nConnectionItem[][];
};

export type N8nConnections = Record<string, N8nNodeConnections>;

export function buildN8nConnections(edges: EdgeIR[]): N8nConnections {
  const connections: N8nConnections = {};

  const sortedEdges = [...edges].sort(compareEdgeForDeterministicOrder);

  for (const edge of sortedEdges) {
    const byNode = (connections[edge.from] ??= { main: [] });
    ensureOutputIndex(byNode.main, edge.fromOutputIndex);

    const output = byNode.main[edge.fromOutputIndex];
    if (!output) {
      throw new Error(`Missing output slot at index ${edge.fromOutputIndex}`);
    }

    output.push({
      node: edge.to,
      type: "main",
      index: edge.toInputIndex,
    });
  }

  return connections;
}

function ensureOutputIndex(outputs: N8nConnectionItem[][], outputIndex: number): void {
  while (outputs.length <= outputIndex) {
    outputs.push([]);
  }
}

function compareEdgeForDeterministicOrder(left: EdgeIR, right: EdgeIR): number {
  const byFrom = compareString(left.from, right.from);
  if (byFrom !== 0) {
    return byFrom;
  }

  const byOutput = left.fromOutputIndex - right.fromOutputIndex;
  if (byOutput !== 0) {
    return byOutput;
  }

  const byTo = compareString(left.to, right.to);
  if (byTo !== 0) {
    return byTo;
  }

  return left.toInputIndex - right.toInputIndex;
}

function compareString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
