import { expect, test } from "bun:test";
import type { WorkflowIR } from "../../src/compiler/ir";
import { validateWorkflow } from "../../src/compiler/validate";

function createValidWorkflow(): WorkflowIR {
  return {
    name: "sample",
    settings: {},
    nodes: [
      { key: "manualTrigger_1", n8nType: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {} },
      { key: "if_2", n8nType: "n8n-nodes-base.if", typeVersion: 1, parameters: {} },
      { key: "noOp_3", n8nType: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {} },
      { key: "noOp_4", n8nType: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {} },
      {
        key: "splitInBatches_5",
        n8nType: "n8n-nodes-base.splitInBatches",
        typeVersion: 3,
        parameters: {},
      },
      { key: "noOp_6", n8nType: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {} },
      { key: "set_7", n8nType: "n8n-nodes-base.set", typeVersion: 1, parameters: {} },
    ],
    edges: [
      { from: "manualTrigger_1", fromOutputIndex: 0, to: "if_2", toInputIndex: 0, kind: undefined },
      { from: "if_2", fromOutputIndex: 0, to: "noOp_3", toInputIndex: 0, kind: undefined },
      { from: "if_2", fromOutputIndex: 1, to: "noOp_4", toInputIndex: 0, kind: undefined },
      {
        from: "noOp_3",
        fromOutputIndex: 0,
        to: "splitInBatches_5",
        toInputIndex: 0,
        kind: undefined,
      },
      {
        from: "noOp_4",
        fromOutputIndex: 0,
        to: "splitInBatches_5",
        toInputIndex: 0,
        kind: undefined,
      },
      {
        from: "splitInBatches_5",
        fromOutputIndex: 1,
        to: "noOp_6",
        toInputIndex: 0,
        kind: undefined,
      },
      {
        from: "noOp_6",
        fromOutputIndex: 0,
        to: "splitInBatches_5",
        toInputIndex: 0,
        kind: "loop-back",
      },
      { from: "splitInBatches_5", fromOutputIndex: 0, to: "set_7", toInputIndex: 0, kind: undefined },
    ],
  };
}

test("validateWorkflow は正しい workflow を受理する", () => {
  const result = validateWorkflow("workflow.ts", createValidWorkflow());
  expect(result.diagnostics).toEqual([]);
});

test("validateWorkflow は必須項目が欠けた schema を E_INVALID_WORKFLOW_SCHEMA で拒否する", () => {
  const workflow = {
    name: "sample",
    settings: {},
    edges: [],
  } as unknown as WorkflowIR;

  const result = validateWorkflow("workflow.ts", workflow);

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "E_INVALID_WORKFLOW_SCHEMA",
      severity: "error",
      file: "workflow.ts",
    }),
  );
});

test("validateWorkflow は scheduleTrigger のみの workflow を受理する", () => {
  const workflow = createValidWorkflow();
  // manualTrigger を scheduleTrigger に差し替え
  workflow.nodes = workflow.nodes.map((node) =>
    node.n8nType === "n8n-nodes-base.manualTrigger"
      ? { ...node, key: "scheduleTrigger_1", n8nType: "n8n-nodes-base.scheduleTrigger" }
      : node,
  );
  workflow.edges = workflow.edges.map((edge) => ({
    ...edge,
    from: edge.from === "manualTrigger_1" ? "scheduleTrigger_1" : edge.from,
    to: edge.to === "manualTrigger_1" ? "scheduleTrigger_1" : edge.to,
  }));

  const result = validateWorkflow("workflow.ts", workflow);
  expect(result.diagnostics).toEqual([]);
});

test("validateWorkflow は trigger 不在を E_INVALID_WORKFLOW_SCHEMA で返す", () => {
  const workflow = createValidWorkflow();
  workflow.nodes = workflow.nodes.filter((node) => node.n8nType !== "n8n-nodes-base.manualTrigger");

  const result = validateWorkflow("workflow.ts", workflow);

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "E_INVALID_WORKFLOW_SCHEMA" }),
  );
});

test("validateWorkflow は存在しないノード参照を E_INVALID_CONNECTION で返す", () => {
  const workflow = createValidWorkflow();
  workflow.edges.push({
    from: "if_2",
    fromOutputIndex: 0,
    to: "missing_node",
    toInputIndex: 0,
    kind: undefined,
  });

  const result = validateWorkflow("workflow.ts", workflow);

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "E_INVALID_CONNECTION" }),
  );
});

test("validateWorkflow は if 配線不正を E_INVALID_CONNECTION で返す", () => {
  const workflow = createValidWorkflow();
  workflow.edges = workflow.edges.filter((edge) => !(edge.from === "if_2" && edge.fromOutputIndex === 1));

  const result = validateWorkflow("workflow.ts", workflow);

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "E_INVALID_CONNECTION" }),
  );
});

test("validateWorkflow は loop back-edge 不足を E_INVALID_CONNECTION で返す", () => {
  const workflow = createValidWorkflow();
  workflow.edges = workflow.edges.filter((edge) => edge.kind !== "loop-back");

  const result = validateWorkflow("workflow.ts", workflow);

  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "E_INVALID_CONNECTION" }),
  );
});
