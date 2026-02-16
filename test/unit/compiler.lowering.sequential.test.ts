import { expect, test } from "bun:test";
import { buildControlFlowGraph } from "../../src/compiler/cfg";
import { extractEntry } from "../../src/compiler/extract-entry";
import type { EdgeIR, WorkflowIR } from "../../src/compiler/ir";
import { lowerControlFlowGraphToIR, type TriggerInput } from "../../src/compiler/lowering";
import { parseSync } from "../../src/compiler/parse";

function lowerFromSource(sourceText: string): WorkflowIR {
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
    triggers: [{ kind: "manualTrigger", parameters: {} }],
    cfg: cfgResult.cfg,
  });
}

function expectEdge(workflow: WorkflowIR, edge: EdgeIR): void {
  expect(workflow.edges).toContainEqual(edge);
}

function expectLoopBackEdge(
  workflow: WorkflowIR,
  fromNodeKey: string,
  loopNodeKey: string,
  fromOutputIndex = 0,
): void {
  expectEdge(workflow, {
    from: fromNodeKey,
    fromOutputIndex,
    to: loopNodeKey,
    toInputIndex: 0,
    kind: "loop-back",
  });
}

test("lowerControlFlowGraphToIR は triggers を先頭に配置し NodeCall/Variable を順次接続する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
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

test("lowerControlFlowGraphToIR は webhookTrigger を n8n webhook ノードに lowering する", () => {
  const workflow = lowerControlFlowGraphToIR({
    name: "sample",
    triggers: [{ kind: "webhookTrigger", parameters: { path: "incoming", httpMethod: "POST" } }],
    cfg: { type: "Block", body: [] },
  });

  expect(workflow.nodes).toEqual([
    expect.objectContaining({
      key: "webhookTrigger_1",
      n8nType: "n8n-nodes-base.webhook",
      typeVersion: 1,
      parameters: { path: "incoming", httpMethod: "POST" },
    }),
  ]);
  expect(workflow.edges).toEqual([]);
});

test("lowerControlFlowGraphToIR は respondToWebhook を n8n respondToWebhook ノードに lowering する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.respondToWebhook({ respondWith: "json", responseBody: "={{$json}}" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual(["manualTrigger_1", "respondToWebhook_2"]);
  expect(workflow.nodes[1]).toEqual(
    expect.objectContaining({
      key: "respondToWebhook_2",
      n8nType: "n8n-nodes-base.respondToWebhook",
      parameters: { respondWith: "json", responseBody: "={{$json}}" },
    }),
  );

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "respondToWebhook_2",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は merge を n8n merge ノードに lowering する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.merge({ mode: "append" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual(["manualTrigger_1", "merge_2"]);
  expect(workflow.nodes[1]).toEqual(
    expect.objectContaining({
      key: "merge_2",
      n8nType: "n8n-nodes-base.merge",
      parameters: { mode: "append" },
    }),
  );

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "merge_2",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は wait を n8n wait ノードに lowering する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.wait({ amount: 1, unit: "minutes", resume: "timeInterval" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual(["manualTrigger_1", "wait_2"]);
  expect(workflow.nodes[1]).toEqual(
    expect.objectContaining({
      key: "wait_2",
      n8nType: "n8n-nodes-base.wait",
      parameters: { amount: 1, unit: "minutes", resume: "timeInterval" },
    }),
  );

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "wait_2",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は Block 内の文も逐次接続する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
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

test("lowerControlFlowGraphToIR は if と for..of n.loop() を組み合わせて逐次接続する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
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
    "if_2",
    "noOp_3",
    "noOp_4",
    "splitInBatches_5",
    "noOp_6",
    "set_7",
  ]);

  expect(workflow.edges).toHaveLength(8);
  expectEdge(workflow, {
    from: "manualTrigger_1",
    fromOutputIndex: 0,
    to: "if_2",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "if_2",
    fromOutputIndex: 0,
    to: "noOp_3",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "if_2",
    fromOutputIndex: 1,
    to: "noOp_4",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "noOp_3",
    fromOutputIndex: 0,
    to: "splitInBatches_5",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "noOp_4",
    fromOutputIndex: 0,
    to: "splitInBatches_5",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "splitInBatches_5",
    fromOutputIndex: 1,
    to: "noOp_6",
    toInputIndex: 0,
    kind: undefined,
  });
  expectLoopBackEdge(workflow, "noOp_6", "splitInBatches_5");
  expectEdge(workflow, {
    from: "splitInBatches_5",
    fromOutputIndex: 0,
    to: "set_7",
    toInputIndex: 0,
    kind: undefined,
  });
});

test("lowerControlFlowGraphToIR は if をノード化して true/false 出力(0/1)を使って接続する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        if (n.expr("={{$json.ok}}")) {
          n.set({ value: "ok" });
        } else {
          n.noOp();
        }

        n.httpRequest({ method: "GET" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "if_2",
    "set_3",
    "noOp_4",
    "httpRequest_5",
  ]);

  const ifNode = workflow.nodes.find((node) => node.key === "if_2");
  expect(ifNode?.parameters).toEqual({ expression: "={{$json.ok}}" });

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "if_2",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "if_2",
      fromOutputIndex: 0,
      to: "set_3",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "if_2",
      fromOutputIndex: 1,
      to: "noOp_4",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "set_3",
      fromOutputIndex: 0,
      to: "httpRequest_5",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "noOp_4",
      fromOutputIndex: 0,
      to: "httpRequest_5",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は else なし if の false 側を合流 frontier として扱う", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        if (n.expr("={{$json.ok}}")) {
          n.noOp();
        }

        n.set({ value: "done" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "if_2",
    "noOp_3",
    "set_4",
  ]);

  expect(workflow.edges).toEqual([
    {
      from: "manualTrigger_1",
      fromOutputIndex: 0,
      to: "if_2",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "if_2",
      fromOutputIndex: 0,
      to: "noOp_3",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "noOp_3",
      fromOutputIndex: 0,
      to: "set_4",
      toInputIndex: 0,
      kind: undefined,
    },
    {
      from: "if_2",
      fromOutputIndex: 1,
      to: "set_4",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は if 条件の node 参照式を if ノード expression に変換する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const check = n.httpRequest({ method: "GET", url: "https://example.com" });

        if (check.ok == true) {
          n.noOp();
        } else {
          n.set({ value: "fallback" });
        }
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "check",
    "if_3",
    "noOp_4",
    "set_5",
  ]);

  const ifNode = workflow.nodes.find((node) => node.key === "if_3");
  expect(ifNode?.parameters).toEqual({ expression: '={{$node["check"].json.ok == true}}' });
});

test("lowerControlFlowGraphToIR は switch を 1 ノード + case/default 分岐配線に lowering する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const req = n.httpRequest({ method: "GET" });

        switch (req.status) {
          case 200:
            n.set({ value: "ok" });
            break;
          case 404:
            n.noOp();
            break;
          default:
            n.set({ value: "fallback" });
        }

        n.httpRequest({ method: "POST" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "req",
    "switch_3",
    "set_4",
    "noOp_5",
    "set_6",
    "httpRequest_7",
  ]);

  const switchNode = workflow.nodes.find((node) => node.key === "switch_3");
  expect(switchNode?.n8nType).toBe("n8n-nodes-base.switch");
  expect(switchNode?.parameters).toEqual({
    expression: '={{$node["req"].json.status}}',
    cases: [{ value: 200 }, { value: 404 }],
  });

  expectEdge(workflow, {
    from: "req",
    fromOutputIndex: 0,
    to: "switch_3",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "switch_3",
    fromOutputIndex: 0,
    to: "set_4",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "switch_3",
    fromOutputIndex: 1,
    to: "noOp_5",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "switch_3",
    fromOutputIndex: 2,
    to: "set_6",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "set_4",
    fromOutputIndex: 0,
    to: "httpRequest_7",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "noOp_5",
    fromOutputIndex: 0,
    to: "httpRequest_7",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "set_6",
    fromOutputIndex: 0,
    to: "httpRequest_7",
    toInputIndex: 0,
    kind: undefined,
  });
});

test("lowerControlFlowGraphToIR は default なし switch の unmatched を後続へ接続する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const req = n.httpRequest({ method: "GET" });

        switch (req.status) {
          case 200:
            n.set({ value: "ok" });
            break;
        }

        n.noOp();
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "req",
    "switch_3",
    "set_4",
    "noOp_5",
  ]);

  expectEdge(workflow, {
    from: "switch_3",
    fromOutputIndex: 0,
    to: "set_4",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "switch_3",
    fromOutputIndex: 1,
    to: "noOp_5",
    toInputIndex: 0,
    kind: undefined,
  });
});

test("lowerControlFlowGraphToIR は if(true)/if(false) を枝刈りして不要な if ノードを作らない", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        if (true) {
          n.noOp();
        }

        if (false) {
          n.httpRequest({ method: "GET" });
        } else {
          n.set({ value: "fallback" });
        }

        n.noOp();
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "noOp_2",
    "set_3",
    "noOp_4",
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
    {
      from: "set_3",
      fromOutputIndex: 0,
      to: "noOp_4",
      toInputIndex: 0,
      kind: undefined,
    },
  ]);
});

test("lowerControlFlowGraphToIR は for..of n.loop() を splitInBatches と back-edge に lowering する", () => {
  const workflow = lowerFromSource(`
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        for (const item of n.loop({ batchSize: 1 })) {
          n.noOp();
        }

        n.set({ value: "done" });
      },
    });
  `);

  expect(workflow.nodes.map((node) => node.key)).toEqual([
    "manualTrigger_1",
    "splitInBatches_2",
    "noOp_3",
    "set_4",
  ]);

  expect(workflow.edges).toHaveLength(4);
  expectEdge(workflow, {
    from: "manualTrigger_1",
    fromOutputIndex: 0,
    to: "splitInBatches_2",
    toInputIndex: 0,
    kind: undefined,
  });
  expectEdge(workflow, {
    from: "splitInBatches_2",
    fromOutputIndex: 1,
    to: "noOp_3",
    toInputIndex: 0,
    kind: undefined,
  });
  expectLoopBackEdge(workflow, "noOp_3", "splitInBatches_2");
  expectEdge(workflow, {
    from: "splitInBatches_2",
    fromOutputIndex: 0,
    to: "set_4",
    toInputIndex: 0,
    kind: undefined,
  });
});
