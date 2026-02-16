import { expect, test } from "bun:test";
import { compile } from "../../src/compiler/compile";

test("compile は parse→extract→cfg/lower→validate を統合して workflow JSON を返す", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      settings: { timezone: "Asia/Tokyo" },
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
  `;

  const result = compile({
    file: "workflow.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.name).toBe("sample");
  expect(result.workflow.settings).toEqual({ timezone: "Asia/Tokyo" });
  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "if_2",
    "noOp_3",
    "noOp_4",
    "splitInBatches_5",
    "noOp_6",
    "set_7",
  ]);
  expect(result.workflow.connections).toEqual({
    if_2: {
      main: [
        [{ node: "noOp_3", type: "main", index: 0 }],
        [{ node: "noOp_4", type: "main", index: 0 }],
      ],
    },
    manualTrigger_1: {
      main: [[{ node: "if_2", type: "main", index: 0 }]],
    },
    noOp_3: {
      main: [[{ node: "splitInBatches_5", type: "main", index: 0 }]],
    },
    noOp_4: {
      main: [[{ node: "splitInBatches_5", type: "main", index: 0 }]],
    },
    noOp_6: {
      main: [[{ node: "splitInBatches_5", type: "main", index: 0 }]],
    },
    splitInBatches_5: {
      main: [
        [{ node: "set_7", type: "main", index: 0 }],
        [{ node: "noOp_6", type: "main", index: 0 }],
      ],
    },
  });
});

test("compile は前ノード変数参照を n8n 式に変換して workflow JSON に反映する", () => {
  const sourceText = `
    export default workflow({
      name: "ref-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        const res = n.httpRequest({ method: "GET", url: "https://example.com" });
        n.set({ values: { data: res.data, id: res.body.id } });
      },
    });
  `;

  const result = compile({
    file: "workflow.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const setNode = result.workflow.nodes.find((node) => node.name === "set_3");
  expect(setNode).toBeDefined();
  expect(setNode?.parameters).toEqual({
    values: {
      string: [
        { name: "data", value: '={{$node["res"].json.data}}' },
        { name: "id", value: '={{$node["res"].json.body.id}}' },
      ],
    },
  });
});

test("compile は scheduleTrigger を含む workflow を正しくコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "scheduled",
      settings: {},
      triggers: [n.scheduleTrigger({ schedules: [{ type: "minutes", intervalMinutes: 5 }] })],
      execute() {
        n.set({ value: "ok" });
      },
    });
  `;

  const result = compile({
    file: "scheduled.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.name).toBe("scheduled");
  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "scheduleTrigger_1",
    "set_2",
  ]);

  const triggerNode = result.workflow.nodes[0];
  expect(triggerNode?.type).toBe("n8n-nodes-base.scheduleTrigger");
  expect(triggerNode?.typeVersion).toBe(1.2);
  expect(triggerNode?.parameters).toEqual({
    rule: { interval: [{ field: "minutes", minutesInterval: 5 }] },
  });

  expect(result.workflow.connections).toEqual({
    scheduleTrigger_1: {
      main: [[{ node: "set_2", type: "main", index: 0 }]],
    },
  });
});

test("compile は manualTrigger と scheduleTrigger を併用できる", () => {
  const sourceText = `
    export default workflow({
      name: "dual-trigger",
      settings: {},
      triggers: [
        n.manualTrigger(),
        n.scheduleTrigger({ schedules: [{ type: "hours", intervalHours: 1 }] }),
      ],
      execute() {
        n.noOp();
      },
    });
  `;

  const result = compile({
    file: "dual.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "scheduleTrigger_2",
    "noOp_3",
  ]);

  expect(result.workflow.nodes[0]?.type).toBe("n8n-nodes-base.manualTrigger");
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.scheduleTrigger");
  expect(result.workflow.nodes[1]?.typeVersion).toBe(1.2);
});

test("compile は webhookTrigger を n8n webhook ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "webhook",
      settings: {},
      triggers: [n.webhookTrigger({ path: "incoming", httpMethod: "POST" })],
      execute() {
        n.set({ value: "ok" });
      },
    });
  `;

  const result = compile({
    file: "webhook.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["webhookTrigger_1", "set_2"]);
  expect(result.workflow.nodes[0]?.type).toBe("n8n-nodes-base.webhook");
  expect(result.workflow.nodes[0]?.parameters).toEqual({ path: "incoming", httpMethod: "POST" });

  expect(result.workflow.connections).toEqual({
    webhookTrigger_1: {
      main: [[{ node: "set_2", type: "main", index: 0 }]],
    },
  });
});

test("compile は respondToWebhook を n8n respondToWebhook ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "respond",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.respondToWebhook({ respondWith: "json", responseBody: "={{$json}}" });
      },
    });
  `;

  const result = compile({
    file: "respond.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "respondToWebhook_2",
  ]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.respondToWebhook");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    respondWith: "json",
    responseBody: "={{$json}}",
  });

  expect(result.workflow.connections).toEqual({
    manualTrigger_1: {
      main: [[{ node: "respondToWebhook_2", type: "main", index: 0 }]],
    },
  });
});

test("compile は sort を n8n sort ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "sort-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.sort({ fields: [{ fieldName: "priority", order: "ascending" }] });
      },
    });
  `;

  const result = compile({
    file: "sort.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "sort_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.sort");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    fields: [{ fieldName: "priority", order: "ascending" }],
  });
});

test("compile は splitOut を n8n splitout ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "split-out-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.splitOut({ fieldToSplitOut: "items" });
      },
    });
  `;

  const result = compile({
    file: "split-out.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "splitOut_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.splitout");
  expect(result.workflow.nodes[1]?.parameters).toEqual({ fieldToSplitOut: "items" });
});

test("compile は merge を n8n merge ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "merge-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.merge({ mode: "append" });
      },
    });
  `;

  const result = compile({
    file: "merge.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "merge_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.merge");
  expect(result.workflow.nodes[1]?.parameters).toEqual({ mode: "append" });
});

test("compile は aggregate を n8n aggregate ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "aggregate-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.aggregate({ aggregate: "sum", field: "amount" });
      },
    });
  `;

  const result = compile({
    file: "aggregate.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "aggregate_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.aggregate");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    aggregate: "sum",
    field: "amount",
  });
});

test("compile は wait を n8n wait ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "wait-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.wait({ amount: 1, unit: "minutes", resume: "timeInterval" });
      },
    });
  `;

  const result = compile({
    file: "wait.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "wait_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.wait");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    amount: 1,
    unit: "minutes",
    resume: "timeInterval",
  });
});

test("compile は filter を n8n filter ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "filter-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.filter({
          conditions: {
            conditions: [
              {
                leftValue: "={{$json.status}}",
                rightValue: "ok",
                operator: { type: "string", operation: "equals" },
              },
            ],
          },
        });
      },
    });
  `;

  const result = compile({
    file: "filter.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "filter_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.filter");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    conditions: {
      conditions: [
        {
          leftValue: "={{$json.status}}",
          rightValue: "ok",
          operator: { type: "string", operation: "equals" },
        },
      ],
    },
  });
});

test("compile は limit を n8n limit ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "limit-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.limit({ maxItems: 10, keep: "firstItems" });
      },
    });
  `;

  const result = compile({
    file: "limit.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "limit_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.limit");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    maxItems: 10,
    keep: "firstItems",
  });
});

test("compile は TS switch 構文を switch ノード + 分岐接続にコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "switch-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        const req = n.httpRequest({ method: "GET", url: "https://example.com" });

        switch (req.status) {
          case 200:
            n.set({ value: "ok" });
            break;
          case 404:
            n.noOp();
            break;
        }

        n.set({ value: "done" });
      },
    });
  `;

  const result = compile({
    file: "switch.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "req",
    "switch_3",
    "set_4",
    "noOp_5",
    "set_6",
  ]);

  const switchNode = result.workflow.nodes.find((node) => node.name === "switch_3");
  expect(switchNode?.type).toBe("n8n-nodes-base.switch");
  expect(switchNode?.parameters).toEqual({
    mode: "rules",
    value: '={{$node["req"].json.status}}',
    rules: {
      values: [
        { outputIndex: 0, operation: "equal", value: 200 },
        { outputIndex: 1, operation: "equal", value: 404 },
      ],
    },
    fallbackOutput: "extra",
  });

  expect(result.workflow.connections.switch_3).toEqual({
    main: [
      [{ node: "set_4", type: "main", index: 0 }],
      [{ node: "noOp_5", type: "main", index: 0 }],
      [{ node: "set_6", type: "main", index: 0 }],
    ],
  });
});

test("compile は validate diagnostics を集約して workflow を返さない", () => {
  const sourceText = `
    export default workflow({
      name: "invalid-workflow",
      triggers: [],
      execute() {
        n.noOp();
      },
    });
  `;

  const result = compile({
    file: "invalid.ts",
    sourceText,
  });

  expect(result.workflow).toBeNull();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "E_INVALID_TRIGGER",
      file: "invalid.ts",
    }),
  );
});
