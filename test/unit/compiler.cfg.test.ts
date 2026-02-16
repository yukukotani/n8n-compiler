import { expect, test } from "bun:test";
import { buildControlFlowGraph } from "../../src/compiler/cfg";
import { extractEntry } from "../../src/compiler/extract-entry";
import { parseSync } from "../../src/compiler/parse";

test("buildControlFlowGraph は MVP 構文 (Block/Expression/Variable/If/Switch/ForOf) を受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        {
          n.noOp();
        }

        const request = n.httpRequest({ method: "GET", url: "https://example.com" });

        if (request.ok == true) {
          n.set({ value: "ok" });
        } else {
          n.noOp();
        }

        if (true) {
          n.noOp();
        }

        switch (request.status) {
          case 200:
            n.set({ value: "ok" });
            break;
          default:
            n.noOp();
        }

        for (const item of n.loop({ batchSize: 1 })) {
          n.noOp();
        }
      },
    });
  `;

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

  expect(cfgResult.cfg.type).toBe("Block");
  expect(cfgResult.cfg.body.map((statement) => statement.type)).toEqual([
    "Block",
    "Variable",
    "If",
    "If",
    "Switch",
    "ForOf",
  ]);

  const variableStatement = cfgResult.cfg.body[1];
  expect(variableStatement?.type).toBe("Variable");
  if (variableStatement?.type === "Variable") {
    expect(variableStatement.name).toBe("request");
    expect(variableStatement.call.kind).toBe("httpRequest");
  }

  const ifStatement = cfgResult.cfg.body[2];
  expect(ifStatement?.type).toBe("If");
  if (ifStatement?.type === "If") {
    expect(ifStatement.test).toEqual({
      type: "ExprCall",
      expression: '={{$node["request"].json.ok == true}}',
    });
  }

  const switchStatement = cfgResult.cfg.body[4];
  expect(switchStatement?.type).toBe("Switch");
  if (switchStatement?.type === "Switch") {
    expect(switchStatement.discriminant).toBe('={{$node["request"].json.status}}');
    expect(switchStatement.cases).toEqual([
      {
        test: 200,
        consequent: [
          {
            type: "NodeCall",
            call: {
              kind: "set",
              parameters: { value: "ok" },
            },
          },
        ],
      },
    ]);
    expect(switchStatement.defaultCase).toEqual([
      {
        type: "NodeCall",
        call: {
          kind: "noOp",
          parameters: {},
        },
      },
    ]);
  }
});

test("buildControlFlowGraph は TS の switch 構文を CFG の Switch として受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const res = n.httpRequest({ method: "GET", url: "https://example.com" });

        switch (res.kind) {
          case "ok":
            n.set({ value: "ok" });
            break;
          case null:
            n.noOp();
            break;
          default:
            n.set({ value: "fallback" });
        }
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const switchStatement = cfgResult.cfg.body[1];
  expect(switchStatement?.type).toBe("Switch");
  if (switchStatement?.type === "Switch") {
    expect(switchStatement.discriminant).toBe('={{$node["res"].json.kind}}');
    expect(switchStatement.cases.map((entry) => entry.test)).toEqual(["ok", null]);
    expect(switchStatement.defaultCase).not.toBeNull();
  }
});

test("buildControlFlowGraph は switch の fallthrough を diagnostics に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const res = n.httpRequest({ method: "GET", url: "https://example.com" });

        switch (res.kind) {
          case "ok":
            n.set({ value: "ok" });
          default:
            n.noOp();
            break;
        }
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.cfg).toBeNull();
  expect(cfgResult.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "E_UNSUPPORTED_STATEMENT",
        message: expect.stringContaining("fallthrough"),
      }),
    ]),
  );
});

test("buildControlFlowGraph は if 条件で前ノード参照式をそのまま書ける", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const check = n.httpRequest({ method: "GET", url: "https://example.com" });

        if (check.ok) {
          n.noOp();
        }

        if (check.ok == true) {
          n.noOp();
        }
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const firstIf = cfgResult.cfg.body[1];
  const secondIf = cfgResult.cfg.body[2];

  expect(firstIf?.type).toBe("If");
  if (firstIf?.type === "If") {
    expect(firstIf.test).toEqual({
      type: "ExprCall",
      expression: '={{!!$node["check"].json.ok}}',
    });
  }

  expect(secondIf?.type).toBe("If");
  if (secondIf?.type === "If") {
    expect(secondIf.test).toEqual({
      type: "ExprCall",
      expression: '={{$node["check"].json.ok == true}}',
    });
  }
});

test("buildControlFlowGraph は前ノード変数の参照を n8n 式に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const res = n.httpRequest({ method: "GET", url: "https://example.com" });
        n.set({ values: { data: res.data, deep: res.body.items, whole: res } });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const setStatement = cfgResult.cfg.body[1];
  expect(setStatement?.type).toBe("NodeCall");
  if (setStatement?.type === "NodeCall") {
    expect(setStatement.call.parameters).toEqual({
      values: {
        data: '={{$node["res"].json.data}}',
        deep: '={{$node["res"].json.body.items}}',
        whole: '={{$node["res"].json}}',
      },
    });
  }
});

test("buildControlFlowGraph は computed プロパティアクセス（文字列・数値）を n8n 式に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        const res = n.httpRequest({ method: "GET", url: "https://example.com" });
        n.set({ values: { first: res[0], keyed: res["content-type"] } });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const setStatement = cfgResult.cfg.body[1];
  expect(setStatement?.type).toBe("NodeCall");
  if (setStatement?.type === "NodeCall") {
    expect(setStatement.call.parameters).toEqual({
      values: {
        first: '={{$node["res"].json[0]}}',
        keyed: '={{$node["res"].json["content-type"]}}',
      },
    });
  }
});

test("buildControlFlowGraph は execute 内の respondToWebhook 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.respondToWebhook({ respondWith: "json", responseBody: "={{$json}}" });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("respondToWebhook");
    expect(statement.call.parameters).toEqual({
      respondWith: "json",
      responseBody: "={{$json}}",
    });
  }
});

test("buildControlFlowGraph は execute 内の sort 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.sort({ fields: [{ fieldName: "priority", order: "ascending" }] });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("sort");
    expect(statement.call.parameters).toEqual({
      fields: [{ fieldName: "priority", order: "ascending" }],
    });
  }
});

test("buildControlFlowGraph は execute 内の splitOut 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.splitOut({ fieldToSplitOut: "items" });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("splitOut");
    expect(statement.call.parameters).toEqual({ fieldToSplitOut: "items" });
  }
});

test("buildControlFlowGraph は execute 内の merge 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.merge({ mode: "append" });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("merge");
    expect(statement.call.parameters).toEqual({ mode: "append" });
  }
});

test("buildControlFlowGraph は execute 内の removeDuplicates 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.removeDuplicates({ fieldsToCompare: "selectedFields", fields: "email" });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("removeDuplicates");
    expect(statement.call.parameters).toEqual({
      fieldsToCompare: "selectedFields",
      fields: "email",
    });
  }
});

test("buildControlFlowGraph は execute 内の aggregate 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.aggregate({ aggregate: "sum", field: "amount" });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("aggregate");
    expect(statement.call.parameters).toEqual({ aggregate: "sum", field: "amount" });
  }
});

test("buildControlFlowGraph は execute 内の wait 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.wait({ amount: 1, unit: "minutes", resume: "timeInterval" });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("wait");
    expect(statement.call.parameters).toEqual({
      amount: 1,
      unit: "minutes",
      resume: "timeInterval",
    });
  }
});

test("buildControlFlowGraph は execute 内の filter 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
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

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("filter");
    expect(statement.call.parameters).toEqual({
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
  }
});

test("buildControlFlowGraph は execute 内の limit 呼び出しを受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.limit({ maxItems: 10, keep: "firstItems" });
      },
    });
  `;

  const parseResult = parseSync("workflow.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("workflow.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("workflow.ts", entryResult.entry.execute);

  expect(cfgResult.diagnostics).toEqual([]);
  expect(cfgResult.cfg).not.toBeNull();

  if (!cfgResult.cfg) {
    throw new Error("cfg is unexpectedly null");
  }

  const statement = cfgResult.cfg.body[0];
  expect(statement?.type).toBe("NodeCall");
  if (statement?.type === "NodeCall") {
    expect(statement.call.kind).toBe("limit");
    expect(statement.call.parameters).toEqual({ maxItems: 10, keep: "firstItems" });
  }
});

test("buildControlFlowGraph は非対応構文を diagnostics に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        return;

        if (ok) {
          n.noOp();
        }

        for (item of n.loop({ batchSize: 1 })) {
          n.noOp();
        }

        for (const item of items) {
          n.noOp();
        }

        n.unknownNode({});
      },
    });
  `;

  const parseResult = parseSync("unsupported.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);
  expect(parseResult.program).not.toBeNull();

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("unsupported.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);
  expect(entryResult.entry).not.toBeNull();

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("unsupported.ts", entryResult.entry.execute);

  expect(cfgResult.cfg).toBeNull();
  expect(cfgResult.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "E_UNSUPPORTED_STATEMENT" }),
      expect.objectContaining({ code: "E_UNSUPPORTED_IF_TEST" }),
      expect.objectContaining({ code: "E_UNSUPPORTED_FOR_FORM" }),
      expect.objectContaining({ code: "E_INVALID_LOOP_SOURCE" }),
      expect.objectContaining({ code: "E_UNKNOWN_NODE_CALL" }),
    ]),
  );
});

test("buildControlFlowGraph は execute 内の scheduleTrigger 呼び出しをエラーにする", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.scheduleTrigger({ schedules: [{ type: "minutes", intervalMinutes: 5 }] });
        n.set({ value: "ok" });
      },
    });
  `;

  const parseResult = parseSync("trigger-in-execute.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("trigger-in-execute.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("trigger-in-execute.ts", entryResult.entry.execute);

  expect(cfgResult.cfg).toBeNull();
  expect(cfgResult.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "E_UNSUPPORTED_STATEMENT",
        message: expect.stringContaining("trigger node"),
      }),
    ]),
  );
});

test("buildControlFlowGraph は execute 内の trigger 呼び出しをエラーにする", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.manualTrigger();
        n.set({ value: "ok" });
      },
    });
  `;

  const parseResult = parseSync("trigger-in-execute.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("trigger-in-execute.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("trigger-in-execute.ts", entryResult.entry.execute);

  expect(cfgResult.cfg).toBeNull();
  expect(cfgResult.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "E_UNSUPPORTED_STATEMENT",
        message: expect.stringContaining("trigger node"),
      }),
    ]),
  );
});

test("buildControlFlowGraph は execute 内の webhookTrigger 呼び出しをエラーにする", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      triggers: [n.manualTrigger()],
      execute() {
        n.webhookTrigger({ path: "incoming", httpMethod: "POST" });
        n.set({ value: "ok" });
      },
    });
  `;

  const parseResult = parseSync("trigger-in-execute.ts", sourceText);
  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const entryResult = extractEntry("trigger-in-execute.ts", parseResult.program);
  expect(entryResult.diagnostics).toEqual([]);

  if (!entryResult.entry) {
    throw new Error("entry is unexpectedly null");
  }

  const cfgResult = buildControlFlowGraph("trigger-in-execute.ts", entryResult.entry.execute);

  expect(cfgResult.cfg).toBeNull();
  expect(cfgResult.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "E_UNSUPPORTED_STATEMENT",
        message: expect.stringContaining("trigger node"),
      }),
    ]),
  );
});
