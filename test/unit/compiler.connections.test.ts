import { expect, test } from "bun:test";
import { buildN8nConnections } from "../../src/compiler/connections";
import type { EdgeIR } from "../../src/compiler/ir";

test("buildN8nConnections は canonical な connections 形式へ変換する", () => {
  const edges: EdgeIR[] = [
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "request",
      toInputIndex: 0,
      kind: undefined,
    },
  ];

  expect(buildN8nConnections(edges)).toEqual({
    manualTrigger_1: {
      main: [[{ node: "request", type: "main", index: 0 }]],
    },
  });
});

test("buildN8nConnections は output index ごとの配列位置を維持し順序を安定化する", () => {
  const edges: EdgeIR[] = [
    {
      from: "if_2",
      fromOutputIndex: 1,
      to: "noOp_4",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "if_2",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "if_2",
      fromOutputIndex: 1,
      to: "httpRequest_5",
      toInputIndex: 0,
      kind: undefined,
    },
  ];

  const connections = buildN8nConnections(edges);

  expect(Object.keys(connections)).toEqual(["if_2", "manualTrigger_1"]);
  expect(connections).toEqual({
    if_2: {
      main: [[], [
        { node: "httpRequest_5", type: "main", index: 0 },
        { node: "noOp_4", type: "main", index: 0 },
      ]],
    },
    manualTrigger_1: {
      main: [[{ node: "if_2", type: "main", index: 0 }]],
    },
  });
});
