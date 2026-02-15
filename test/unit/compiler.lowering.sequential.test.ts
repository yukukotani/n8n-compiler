import { expect, test } from "bun:test";
import { buildControlFlowGraph } from "../../src/compiler/cfg";
import { extractEntry } from "../../src/compiler/extract-entry";
import { lowerControlFlowGraphToIR } from "../../src/compiler/lowering";
import { parseSync } from "../../src/compiler/parse";

function lowerFromSource(sourceText: string) {
  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);
  expect(parseResult.program).not.toBeNull();

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);
  expect(entryResult.entry).not.toBeNull();

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);
  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  return lowerControlFlowGraphToIR({
    name: "sample",
    cfg: cfgResult.cfg,
  });
}

test("lowerControlFlowGraphToIR は NodeCall/Variable を順次接続し frontier を更新する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      execute() {
        n.manualTrigger();
        const request = n.httpRequest({ method: "GET" });
        n.set({ value: "ok" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "request",
    "set_3",
  ]);

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "request",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "request",
      fromOutputIndex: 0,
      to: "set_3",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は Block 内の文も逐次接続する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      execute() {
        n.manualTrigger();
        {
          n.noOp();
        }
        n.set({ value: "done" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "noOp_2",
    "set_3",
  ]);

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "noOp_2",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "noOp_2",
      fromOutputIndex: 0,
      to: "set_3",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は if/for があっても逐次接続を壊さない", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      execute() {
        n.manualTrigger();

        if (n.expr("={{$json.ok}}")) {
          n.noOp();
        } else {
          n.noOp();
        }

        for (const item of n.loop({ batchSize: 1 })) {
          n.noOp();
        }

        n.set({ value: "done" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "set_2",
  ]);

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "set_2",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});
