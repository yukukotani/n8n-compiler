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

        if (n.expr("={{$json.ok === true}}")) {
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
