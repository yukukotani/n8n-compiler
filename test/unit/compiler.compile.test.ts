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

test("compile はパラメータ内の CallExpression を n8n 式文字列としてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "call-expr",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.respondToWebhook({
          respondWith: "json",
          responseBody: JSON.stringify({ pong: true }),
        });
      },
    });
  `;

  const result = compile({
    file: "call-expr.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const respondNode = result.workflow.nodes[1];
  expect(respondNode?.type).toBe("n8n-nodes-base.respondToWebhook");
  expect(respondNode?.parameters).toEqual({
    respondWith: "json",
    responseBody: '={{JSON.stringify({ pong: true })}}',
  });
});

test("compile はパラメータ内の CallExpression でノード参照を解決する", () => {
  const sourceText = `
    export default workflow({
      name: "call-node-ref",
      settings: {},
      triggers: [n.webhookTrigger({ path: "test" })],
      execute(trigger) {
        n.respondToWebhook({
          respondWith: "json",
          responseBody: JSON.stringify(trigger.body),
        });
      },
    });
  `;

  const result = compile({
    file: "call-ref.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const respondNode = result.workflow.nodes[1];
  expect(respondNode?.parameters).toEqual({
    respondWith: "json",
    responseBody: '={{JSON.stringify($node["trigger"].json.body)}}',
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

test("compile は summarize を n8n summarize ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "summarize-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.summarize({ fieldsToSummarize: ["content"] });
      },
    });
  `;

  const result = compile({
    file: "summarize.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "summarize_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.summarize");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    fieldsToSummarize: ["content"],
  });
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

test("compile は removeDuplicates を n8n removeduplicates ノードとしてコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "remove-duplicates-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.removeDuplicates({ fieldsToCompare: "selectedFields", fields: "email" });
      },
    });
  `;

  const result = compile({
    file: "remove-duplicates.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "removeDuplicates_2",
  ]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.removeduplicates");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    fieldsToCompare: "selectedFields",
    fields: "email",
  });
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

test("compile は code を n8n code ノードとしてコンパイルし arrow function body を jsCode 文字列にする", () => {
  const sourceText = `
    export default workflow({
      name: "code-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.code({ jsCode: () => { return items; }, mode: "runOnceForAllItems" });
      },
    });
  `;

  const result = compile({
    file: "code.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual(["manualTrigger_1", "code_2"]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.code");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    jsCode: "return items;",
    mode: "runOnceForAllItems",
  });
});

test("compile は executeWorkflow を n8n executeworkflow ノードとしてコンパイルし params を透過する", () => {
  const sourceText = `
    export default workflow({
      name: "execute-workflow-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.executeWorkflow({ workflowId: "wf_123", mode: "once", options: { waitForSubWorkflow: true } });
      },
    });
  `;

  const result = compile({
    file: "execute-workflow.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "executeWorkflow_2",
  ]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.executeWorkflow");
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    workflowId: "wf_123",
    mode: "once",
    options: { waitForSubWorkflow: true },
  });
});

test("compile は executeWorkflow の workflowInputs に $('...').item.json を含む場合も workflowId を保持する", () => {
  const sourceText = `
    export default workflow({
      name: "execute-workflow-with-ref",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.noOp({}, { name: "A" });
        n.executeWorkflow({
          workflowId: "FNhxFBi6zRWPpmOF",
          workflowInputs: {
            mappingMode: "defineBelow",
            value: { email: $('A').item.json.email, startDate: $('A').item.json.startDate },
          },
          mode: "each",
        });
      },
    });
  `;

  const result = compile({
    file: "execute-workflow-ref.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const ewNode = result.workflow.nodes.find((n) => n.type === "n8n-nodes-base.executeWorkflow");
  expect(ewNode).toBeDefined();
  expect(ewNode!.parameters).toEqual({
    workflowId: "FNhxFBi6zRWPpmOF",
    workflowInputs: {
      mappingMode: "defineBelow",
      value: {
        email: '={{$("A").item.json.email}}',
        startDate: '={{$("A").item.json.startDate}}',
      },
    },
    mode: "each",
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

test("compile は googleCalendarTrigger をコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "gcal-trigger",
      settings: {},
      triggers: [n.googleCalendarTrigger({ calendarId: "test@example.com", triggerOn: "eventCreated" })],
      execute() {
        n.noOp();
      },
    });
  `;

  const result = compile({
    file: "gcal.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "googleCalendarTrigger_1",
    "noOp_2",
  ]);
  expect(result.workflow.nodes[0]?.type).toBe("n8n-nodes-base.googleCalendarTrigger");
  expect(result.workflow.nodes[0]?.parameters).toEqual({
    calendarId: "test@example.com",
    triggerOn: "eventCreated",
  });
});

test("compile は googleCalendar アクションノードをコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "gcal-action",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.googleCalendar({ start: "2025-01-01", end: "2025-01-02" });
      },
    });
  `;

  const result = compile({
    file: "gcal-action.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "googleCalendar_2",
  ]);
  expect(result.workflow.nodes[1]?.type).toBe("n8n-nodes-base.googleCalendar");
  expect(result.workflow.nodes[1]?.typeVersion).toBe(1.3);
  expect(result.workflow.nodes[1]?.parameters).toEqual({
    start: "2025-01-01",
    end: "2025-01-02",
  });
});

test("compile は n.parallel() で fan-out 接続をコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "parallel-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        const [_a, _b, _c] = n.parallel(
          () => n.set({ value: "a" }),
          () => n.set({ value: "b" }),
          () => n.noOp(),
        );
      },
    });
  `;

  const result = compile({
    file: "parallel.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "a",
    "b",
    "c",
  ]);

  // All 3 nodes should be connected from the trigger (order may vary)
  const output0 = result.workflow.connections.manualTrigger_1?.main?.[0];
  expect(output0).toHaveLength(3);
  expect(output0).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ node: "a" }),
      expect.objectContaining({ node: "b" }),
      expect.objectContaining({ node: "c" }),
    ]),
  );
});

test("compile は if-without-else を正しくコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "if-no-else",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        if (n.expr("={{$json.ok}}")) {
          n.noOp();
        }
      },
    });
  `;

  const result = compile({
    file: "if-no-else.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "if_2",
    "noOp_3",
  ]);

  // Only true branch should be wired
  expect(result.workflow.connections.if_2).toEqual({
    main: [
      [{ node: "noOp_3", type: "main", index: 0 }],
    ],
  });
});

test("compile はノードオプション (credentials/name) を反映する", () => {
  const sourceText = `
    export default workflow({
      name: "options-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.httpRequest(
          { method: "GET", url: "https://example.com" },
          { name: "my request", credentials: { httpBasicAuth: { id: "cred-1", name: "My Auth" } } },
        );
      },
    });
  `;

  const result = compile({
    file: "options.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  expect(httpNode?.name).toBe("my request");
  expect(httpNode?.credentials).toEqual({
    httpBasicAuth: { id: "cred-1", name: "My Auth" },
  });
});

test("compile はトリガーオプション (credentials) を反映する", () => {
  const sourceText = `
    export default workflow({
      name: "trigger-options-test",
      settings: {},
      triggers: [
        n.googleCalendarTrigger(
          { calendarId: "test@example.com" },
          { credentials: { googleCalendarOAuth2Api: { id: "cred-1", name: "Google Cal" } } },
        ),
      ],
      execute() {
        n.noOp();
      },
    });
  `;

  const result = compile({
    file: "trigger-options.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const triggerNode = result.workflow.nodes[0];
  expect(triggerNode?.type).toBe("n8n-nodes-base.googleCalendarTrigger");
  expect(triggerNode?.credentials).toEqual({
    googleCalendarOAuth2Api: { id: "cred-1", name: "Google Cal" },
  });
});

test("compile は httpRequest v4.2 の method をそのまま保持する", () => {
  const sourceText = `
    export default workflow({
      name: "http-v4",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.httpRequest({
          method: "POST",
          url: "https://example.com/api",
          authentication: "predefinedCredentialType",
          sendBody: true,
          specifyBody: "json",
          jsonBody: "={}",
        });
      },
    });
  `;

  const result = compile({
    file: "http-v4.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  expect(httpNode?.typeVersion).toBe(4.2);
  expect(httpNode?.parameters.method).toBe("POST");
  expect(httpNode?.parameters.requestMethod).toBeUndefined();
  expect(httpNode?.parameters.authentication).toBe("predefinedCredentialType");
  expect(httpNode?.parameters.sendBody).toBe(true);
});

test("compile は jsonBody の JS object を n8n の ={...} 形式に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "jsonbody-object",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.httpRequest({
          method: "POST",
          url: "https://example.com/api",
          sendBody: true,
          specifyBody: "json",
          jsonBody: { foo: "bar", num: 42 },
        });
      },
    });
  `;

  const result = compile({
    file: "jsonbody-object.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  expect(httpNode?.parameters.jsonBody).toBe('={"foo":"bar","num":42}');
});

test("compile は jsonBody 内の raw 式を n8n の {{ expr }} 形式に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "jsonbody-expr",
      settings: {},
      triggers: [
        n.googleCalendarTrigger(
          { calendarId: "test@example.com", triggerOn: "eventCreated" },
          { name: "Google Calendar Trigger" },
        ),
      ],
      execute(googleCalendar) {
        n.httpRequest({
          method: "POST",
          url: "https://example.com/api",
          sendBody: true,
          specifyBody: "json",
          jsonBody: {
            summary: "hello",
            dateTime: googleCalendar.start.dateTime,
            requestId: Math.floor(Math.random() * 999999999),
          },
        });
      },
    });
  `;

  const result = compile({
    file: "jsonbody-expr.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  const jsonBody = httpNode?.parameters.jsonBody as string;
  expect(jsonBody.startsWith("=")).toBe(true);

  // Trigger reference should use $('Name').item.json format in {{ }}
  expect(jsonBody).toContain("{{ $('Google Calendar Trigger').item.json.start.dateTime }}");
  // General expression should also be in {{ }} format
  expect(jsonBody).toContain("{{ Math.floor(Math.random() * 999999999) }}");
  // Literal values should be plain
  expect(jsonBody).toContain('"hello"');
});

test("compile は面接ブロック相当のワークフローをコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "面接ブロック",
      settings: {},
      triggers: [
        n.googleCalendarTrigger(
          { calendarId: "y.kotani@salescore.jp", triggerOn: "eventCreated" },
          { credentials: { googleCalendarOAuth2Api: { id: "rbYinvqPmgGIoNpL", name: "(yuku) Google Calendar" } } },
        ),
      ],
      execute() {
        if (n.expr('={{ !$json.summary.includes("【自動】") }}')) {
          if (n.expr('={{ $json.summary.includes("面接") || $json.summary.includes("オンラインミーティング") }}')) {
            n.parallel(
              () => {
                n.httpRequest({
                  method: "POST",
                  url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
                  authentication: "predefinedCredentialType",
                  sendBody: true,
                  specifyBody: "json",
                }, { name: "work task", credentials: { googleCalendarOAuth2Api: { id: "rbYinvqPmgGIoNpL" } } });
              },
              () => {
                n.httpRequest({
                  method: "POST",
                  url: "https://www.googleapis.com/calendar/v3/calendars/poyo0315@gmail.com/events?conferenceDataVersion=1",
                  authentication: "predefinedCredentialType",
                  sendBody: true,
                  specifyBody: "json",
                }, { name: "personal task", credentials: { googleCalendarOAuth2Api: { id: "rbYinvqPmgGIoNpL" } } });
              },
              () => {
                n.googleCalendar({
                  start: "={{ $json.start.dateTime }}",
                  end: "={{ $json.end.dateTime }}",
                }, { name: "all-day blocker", credentials: { googleCalendarOAuth2Api: { id: "rbYinvqPmgGIoNpL" } } });
              },
            );
          }
        }
      },
    });
  `;

  const result = compile({
    file: "interview.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.name).toBe("面接ブロック");
  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "googleCalendarTrigger_1",
    "if_2",
    "if_3",
    "work task",
    "personal task",
    "all-day blocker",
  ]);

  // Trigger → first if
  expect(result.workflow.connections.googleCalendarTrigger_1).toEqual({
    main: [[{ node: "if_2", type: "main", index: 0 }]],
  });

  // First if true → second if
  expect(result.workflow.connections.if_2).toEqual({
    main: [[{ node: "if_3", type: "main", index: 0 }]],
  });

  // Second if true → 3 parallel nodes
  const secondIfConnections = result.workflow.connections.if_3;
  expect(secondIfConnections?.main?.[0]).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ node: "work task" }),
      expect.objectContaining({ node: "personal task" }),
      expect.objectContaining({ node: "all-day blocker" }),
    ]),
  );
  expect(secondIfConnections?.main?.[0]).toHaveLength(3);

  // work task has credentials
  const workTask = result.workflow.nodes.find((n) => n.name === "work task");
  expect(workTask?.credentials).toEqual({
    googleCalendarOAuth2Api: { id: "rbYinvqPmgGIoNpL" },
  });
  expect(workTask?.type).toBe("n8n-nodes-base.httpRequest");
  expect(workTask?.typeVersion).toBe(4.2);

   // all-day blocker is googleCalendar
  const blocker = result.workflow.nodes.find((n) => n.name === "all-day blocker");
  expect(blocker?.type).toBe("n8n-nodes-base.googleCalendar");
  expect(blocker?.typeVersion).toBe(1.3);
});

test("compile は execute パラメータでトリガー出力を参照できる", () => {
  const sourceText = `
    export default workflow({
      name: "trigger-ref",
      settings: {},
      triggers: [n.webhookTrigger({ path: "incoming", httpMethod: "POST" })],
      execute(trigger) {
        n.set({ values: { body: trigger.body, path: trigger.headers["x-path"] } });
      },
    });
  `;

  const result = compile({
    file: "trigger-ref.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  // Trigger node name should be "trigger" (matching the execute param name)
  expect(result.workflow.nodes[0]?.name).toBe("trigger");

  // Set node should have n8n expressions referencing the trigger
  const setNode = result.workflow.nodes[1];
  expect(setNode?.parameters).toEqual({
    values: {
      string: [
        { name: "body", value: '={{$node["trigger"].json.body}}' },
        { name: "path", value: '={{$node["trigger"].json.headers["x-path"]}}' },
      ],
    },
  });

  // Connection should use trigger's variable name
  expect(result.workflow.connections.trigger).toEqual({
    main: [[{ node: "set_2", type: "main", index: 0 }]],
  });
});

test("compile は displayName 付きトリガーの参照を正しい表示名で解決する", () => {
  const sourceText = `
    export default workflow({
      name: "display-name-ref",
      settings: {},
      triggers: [n.googleCalendarTrigger({ calendarId: "test" }, { name: "Google Calendar Trigger" })],
      execute(googleCalendar) {
        n.set({ values: { start: googleCalendar.start.dateTime } });
      },
    });
  `;

  const result = compile({
    file: "display-name-ref.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  // Trigger should use display name
  expect(result.workflow.nodes[0]?.name).toBe("Google Calendar Trigger");

  // Set node references should use the display name, not the variable name
  const setNode = result.workflow.nodes[1];
  expect(setNode?.parameters).toEqual({
    values: {
      string: [
        { name: "start", value: '={{$node["Google Calendar Trigger"].json.start.dateTime}}' },
      ],
    },
  });
});

test("compile は @name JSDoc 付き変数宣言でも正しい表示名で参照を解決する", () => {
  const sourceText = `
    export default workflow({
      name: "jsdoc-ref",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        /** @name My Request */
        const myReq = n.httpRequest({ method: "GET", url: "https://example.com" });
        n.set({ values: { data: myReq.body } });
      },
    });
  `;

  const result = compile({
    file: "jsdoc-ref.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  // Node should use JSDoc display name
  expect(result.workflow.nodes[1]?.name).toBe("My Request");

  // Set node references should use the display name
  const setNode = result.workflow.nodes[2];
  expect(setNode?.parameters).toEqual({
    values: {
      string: [
        { name: "data", value: '={{$node["My Request"].json.body}}' },
      ],
    },
  });
});

test("compile は複数トリガーの execute パラメータ参照を正しく処理する", () => {
  const sourceText = `
    export default workflow({
      name: "multi-trigger",
      settings: {},
      triggers: [
        n.manualTrigger(),
        n.scheduleTrigger({ schedules: [{ type: "minutes", intervalMinutes: 5 }] }),
      ],
      execute(manual, schedule) {
        n.noOp();
      },
    });
  `;

  const result = compile({
    file: "multi.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes[0]?.name).toBe("manual");
  expect(result.workflow.nodes[1]?.name).toBe("schedule");
});

test("compile は execute パラメータ数がトリガー数を超えるとエラーにする", () => {
  const sourceText = `
    export default workflow({
      name: "too-many-params",
      settings: {},
      triggers: [n.manualTrigger()],
      execute(a, b) {
        n.noOp();
      },
    });
  `;

  const result = compile({
    file: "bad.ts",
    sourceText,
  });

  expect(result.workflow).toBeNull();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "E_INVALID_WORKFLOW_SCHEMA",
    }),
  );
});

test("compile は for...of ノード参照を splitInBatches にコンパイルする", () => {
  const sourceText = `
    export default workflow({
      name: "node-ref-loop",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        const list = n.httpRequest({ method: "GET", url: "https://example.com/items" });

        for (const item of list.data) {
          n.noOp();
        }

        n.set({ value: "done" });
      },
    });
  `;

  const result = compile({
    file: "node-ref-loop.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "list",
    "splitInBatches_3",
    "noOp_4",
    "set_5",
  ]);

  expect(result.workflow.connections).toEqual({
    manualTrigger_1: {
      main: [[{ node: "list", type: "main", index: 0 }]],
    },
    list: {
      main: [[{ node: "splitInBatches_3", type: "main", index: 0 }]],
    },
    noOp_4: {
      main: [[{ node: "splitInBatches_3", type: "main", index: 0 }]],
    },
    splitInBatches_3: {
      main: [
        [{ node: "set_5", type: "main", index: 0 }],
        [{ node: "noOp_4", type: "main", index: 0 }],
      ],
    },
  });
});

test("compile は for...of ループ内のテンプレートリテラルで反復変数を解決する", () => {
  const sourceText = "export default workflow({" +
    'name: "tpl-loop",' +
    "settings: {}," +
    "triggers: [n.manualTrigger()]," +
    "execute() {" +
    '  const list = n.httpRequest({ method: "GET", url: "https://example.com/items" });' +
    "  for (const item of list.data) {" +
    "    n.httpRequest({ method: \"GET\", url: `https://example.com/\${item.name}` });" +
    "  }" +
    "}," +
    "});";

  const result = compile({
    file: "tpl-loop.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(result.workflow.nodes.map((node) => node.name)).toEqual([
    "manualTrigger_1",
    "list",
    "splitInBatches_3",
    "httpRequest_4",
  ]);

  const httpNode = result.workflow.nodes.find((node) => node.name === "httpRequest_4");
  expect(httpNode?.parameters).toEqual({
    method: "GET",
    url: "=https://example.com/{{ $json.name }}",
  });
});

test("compile は for...of ループ内の if 条件で反復変数を参照できる", () => {
  const sourceText = `
    export default workflow({
      name: "loop-if-ref",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        const list = n.httpRequest({ method: "GET", url: "https://example.com" });

        for (const item of list.data) {
          if (item.active == true) {
            n.noOp();
          } else {
            n.noOp();
          }
        }
      },
    });
  `;

  const result = compile({
    file: "loop-if-ref.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  // if node should reference $json (loop variable) not $node["item"]
  const ifNode = result.workflow.nodes.find((node) => node.name.startsWith("if_"));
  expect(ifNode).toBeDefined();
  expect(ifNode?.parameters).toEqual({
    conditions: {
      options: {
        caseSensitive: true,
        leftValue: "",
        typeValidation: "strict",
      },
      conditions: [
        {
          leftValue: "={{$json.active == true}}",
          rightValue: true,
          operator: {
            type: "boolean",
            operation: "true",
          },
        },
      ],
      combinator: "and",
    },
    options: {},
  });
});

test("compile は @name JSDoc で変数宣言のノード表示名を上書きする", () => {
  const sourceText = `
    export default workflow({
      name: "jsdoc-name-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        /** @name My Custom Request */
        const myCustomRequest = n.httpRequest(
          { method: "GET", url: "https://example.com" },
          { credentials: { httpBasicAuth: { id: "cred-1" } } },
        );
      },
    });
  `;

  const result = compile({
    file: "jsdoc-name.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  expect(httpNode?.name).toBe("My Custom Request");
  expect(httpNode?.credentials).toEqual({
    httpBasicAuth: { id: "cred-1" },
  });
});

test("compile は @name JSDoc で式文のノード表示名を上書きする", () => {
  const sourceText = `
    export default workflow({
      name: "jsdoc-name-expr-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        /** @name work task */
        n.httpRequest({ method: "POST", url: "https://example.com" });
      },
    });
  `;

  const result = compile({
    file: "jsdoc-name-expr.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  expect(httpNode?.name).toBe("work task");
});

test("compile は @name JSDoc が options.name より優先される", () => {
  const sourceText = `
    export default workflow({
      name: "jsdoc-override-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        /** @name JSDoc Name */
        n.httpRequest(
          { method: "GET", url: "https://example.com" },
          { name: "Options Name" },
        );
      },
    });
  `;

  const result = compile({
    file: "jsdoc-override.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  expect(httpNode?.name).toBe("JSDoc Name");
});

test("compile はトップレベル const 参照 (shorthand) の credentials を正しく解決する", () => {
  const sourceText = `
    const httpBasicAuth = { id: "cred-1", name: "My Auth" };

    export default workflow({
      name: "const-ref-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.httpRequest(
          { method: "GET", url: "https://example.com" },
          { credentials: { httpBasicAuth } },
        );
      },
    });
  `;

  const result = compile({
    file: "const-ref.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const httpNode = result.workflow.nodes[1];
  expect(httpNode?.credentials).toEqual({
    httpBasicAuth: { id: "cred-1", name: "My Auth" },
  });
});

test("compile はトップレベル const 参照をトリガーの credentials でも解決する", () => {
  const sourceText = `
    const googleCalendarOAuth2Api = { id: "cred-1", name: "Google Cal" };

    export default workflow({
      name: "const-trigger-test",
      settings: {},
      triggers: [
        n.googleCalendarTrigger(
          { calendarId: "test@example.com" },
          { credentials: { googleCalendarOAuth2Api } },
        ),
      ],
      execute() {
        n.noOp();
      },
    });
  `;

  const result = compile({
    file: "const-trigger.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const triggerNode = result.workflow.nodes[0];
  expect(triggerNode?.type).toBe("n8n-nodes-base.googleCalendarTrigger");
  expect(triggerNode?.credentials).toEqual({
    googleCalendarOAuth2Api: { id: "cred-1", name: "Google Cal" },
  });
});

test("compile は直接記述された DateTime + $ 式を n8n 式文字列にコンパイルする", () => {
  const sourceText = `
    import { n, workflow, DateTime, $ } from "../src/dsl";

    export default workflow({
      name: "datetime-compile",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.googleCalendar({
          start: DateTime.fromISO($('Google Calendar Trigger').item.json.start.dateTime).set({ hour: 9 }),
          end: DateTime.fromISO($('Google Calendar Trigger').item.json.start.dateTime).set({ hour: 19 }),
        });
      },
    });
  `;

  const result = compile({
    file: "datetime-compile.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const calNode = result.workflow.nodes[1];
  expect(calNode?.type).toBe("n8n-nodes-base.googleCalendar");
  expect(calNode?.parameters).toEqual({
    start: '={{DateTime.fromISO($("Google Calendar Trigger").item.json.start.dateTime).set({ hour: 9 })}}',
    end: '={{DateTime.fromISO($("Google Calendar Trigger").item.json.start.dateTime).set({ hour: 19 })}}',
  });
});

test("compile はトップレベル const 参照をパラメータ内でも解決する", () => {
  const sourceText = `
    const calendarId = { __rl: true, mode: "list", value: "test@example.com" };

    export default workflow({
      name: "const-param-test",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.googleCalendar({
          calendar: calendarId,
          start: "2025-01-01",
          end: "2025-01-02",
        });
      },
    });
  `;

  const result = compile({
    file: "const-param.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const calNode = result.workflow.nodes[1];
  expect(calNode?.parameters).toEqual(
    expect.objectContaining({
      calendar: { __rl: true, mode: "list", value: "test@example.com" },
    }),
  );
});

test("compile は googleSheets にデフォルト typeVersion 4.5 を適用する", () => {
  const sourceText = `
    export default workflow({
      name: "sheets-default-version",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.googleSheets({
          authentication: "serviceAccount",
          documentId: { __rl: true, mode: "url", value: "https://docs.google.com/spreadsheets/d/abc123" },
          sheetName: { __rl: true, mode: "id", value: "0" },
        });
      },
    });
  `;

  const result = compile({ file: "sheets-version.ts", sourceText });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const sheetsNode = result.workflow.nodes[1];
  expect(sheetsNode?.type).toBe("n8n-nodes-base.googleSheets");
  expect(sheetsNode?.typeVersion).toBe(4.5);
});

test("compile はアクションノードの options.typeVersion で typeVersion を明示上書きできる", () => {
  const sourceText = `
    export default workflow({
      name: "sheets-explicit-version",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        n.googleSheets({
          authentication: "serviceAccount",
          documentId: { __rl: true, mode: "url", value: "https://docs.google.com/spreadsheets/d/abc123" },
          sheetName: { __rl: true, mode: "id", value: "0" },
        }, { typeVersion: 4.7 });
      },
    });
  `;

  const result = compile({ file: "sheets-explicit-version.ts", sourceText });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const sheetsNode = result.workflow.nodes[1];
  expect(sheetsNode?.type).toBe("n8n-nodes-base.googleSheets");
  expect(sheetsNode?.typeVersion).toBe(4.7);
});

test("compile はトリガーの options.typeVersion で typeVersion を明示上書きできる", () => {
  const sourceText = `
    export default workflow({
      name: "trigger-version",
      settings: {},
      triggers: [n.formTrigger({}, { typeVersion: 2.1 })],
      execute() {
        n.noOp();
      },
    });
  `;

  const result = compile({ file: "trigger-version.ts", sourceText });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const triggerNode = result.workflow.nodes[0];
  expect(triggerNode?.type).toBe("n8n-nodes-base.formTrigger");
  expect(triggerNode?.typeVersion).toBe(2.1);
});

test("compile は jsCode 内の前ノード const 参照を $input.first().json に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "code-input-ref",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        const httpRequest = n.httpRequest({ method: "GET", url: "https://example.com" });
        n.code({ jsCode: () => {
          const result = httpRequest;
          return [{ json: { ok: result.ok } }];
        } });
      },
    });
  `;

  const result = compile({ file: "code-input-ref.ts", sourceText });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const codeNode = result.workflow.nodes.find(n => n.type === "n8n-nodes-base.code");
  expect(codeNode).toBeDefined();
  // httpRequest (the immediately preceding node) should become $input.first().json
  expect(codeNode!.parameters.jsCode).toContain("$input.first().json");
  expect(codeNode!.parameters.jsCode).not.toContain("httpRequest");
});

test("compile は jsCode 内の非直前ノード const 参照を $node[].json に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "code-node-ref",
      settings: {},
      triggers: [n.manualTrigger()],
      execute() {
        const httpRequest = n.httpRequest({ method: "GET", url: "https://example.com" });
        n.set({ values: { status: "ok" } });
        n.code({ jsCode: () => {
          const data = httpRequest;
          return [{ json: data }];
        } });
      },
    });
  `;

  const result = compile({ file: "code-node-ref.ts", sourceText });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const codeNode = result.workflow.nodes.find(n => n.type === "n8n-nodes-base.code");
  expect(codeNode).toBeDefined();
  // httpRequest is NOT the immediately preceding node (set is), so it becomes $node reference
  expect(codeNode!.parameters.jsCode).toContain('$node["httpRequest"].json');
  expect(codeNode!.parameters.jsCode).not.toContain("$input");
});

test("compile は jsCode 内のトリガーパラメータ参照を $input.first().json に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "code-trigger-ref",
      settings: {},
      triggers: [n.webhookTrigger({ path: "test", httpMethod: "POST" })],
      execute(webhook) {
        n.code({ jsCode: () => {
          const body = webhook.body;
          return [{ json: body }];
        } });
      },
    });
  `;

  const result = compile({ file: "code-trigger-ref.ts", sourceText });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  const codeNode = result.workflow.nodes.find(n => n.type === "n8n-nodes-base.code");
  expect(codeNode).toBeDefined();
  // webhook is the only preceding node variable, so it becomes $input.first().json
  expect(codeNode!.parameters.jsCode).toContain("$input.first().json.body");
});
