import { expect, test } from "bun:test";
import { buildControlFlowGraph } from "../../src/compiler/cfg";
import { extractEntry } from "../../src/compiler/extract-entry";
import { parseSync } from "../../src/compiler/parse";

test("buildControlFlowGraph は MVP 構文 (Block/Expression/Variable/If/ForOf) を受理する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      execute() {
        {
          n.noOp();
        }

        n.manualTrigger();
        const request = n.httpRequest({ method: "GET", url: "https://example.com" });

        if (request.ok == true) {
          n.set({ value: "ok" });
        } else {
          n.noOp();
        }

        if (true) {
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
    "NodeCall",
    "Variable",
    "If",
    "If",
    "ForOf",
  ]);

  const variableStatement = cfgResult.cfg.body[2];
  expect(variableStatement?.type).toBe("Variable");
  if (variableStatement?.type === "Variable") {
    expect(variableStatement.name).toBe("request");
    expect(variableStatement.call.kind).toBe("httpRequest");
  }

  const ifStatement = cfgResult.cfg.body[3];
  expect(ifStatement?.type).toBe("If");
  if (ifStatement?.type === "If") {
    expect(ifStatement.test).toEqual({
      type: "ExprCall",
      expression: '={{$node["request"].json.ok == true}}',
    });
  }
});

test("buildControlFlowGraph は if 条件で前ノード参照式をそのまま書ける", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      execute() {
        n.manualTrigger();
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

  const firstIf = cfgResult.cfg.body[2];
  const secondIf = cfgResult.cfg.body[3];

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
      execute() {
        n.manualTrigger();
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

  const setStatement = cfgResult.cfg.body[2];
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
      execute() {
        n.manualTrigger();
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

  const setStatement = cfgResult.cfg.body[2];
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

test("buildControlFlowGraph は非対応構文を diagnostics に変換する", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
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
