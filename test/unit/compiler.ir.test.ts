import { expect, test } from "bun:test";
import {
  createDeterministicId,
  createEdgeIR,
  createNodeIR,
  createNodeKey,
  createWorkflowIRFrame,
} from "../../src/compiler/ir";

test("WorkflowIR は最小のワークフロー枠を生成できる", () => {
  const workflow = createWorkflowIRFrame({
    name: "sample",
    settings: { timezone: "Asia/Tokyo" },
  });

  expect(workflow).toEqual({
    name: "sample",
    settings: { timezone: "Asia/Tokyo" },
    nodes: [],
    edges: [],
  });
});

test("NodeIR / EdgeIR の期待形状を満たす", () => {
  const trigger = createNodeIR({
    kind: "manualTrigger",
    n8nType: "n8n-nodes-base.manualTrigger",
    variableName: "trigger",
    counter: 1,
    parameters: {},
  });
  const request = createNodeIR({
    kind: "httpRequest",
    n8nType: "n8n-nodes-base.httpRequest",
    counter: 2,
    parameters: { method: "GET" },
  });
  const edge = createEdgeIR({
    from: trigger.key,
    to: request.key,
    fromOutputIndex: 0,
    toInputIndex: 0,
  });

  expect(trigger).toEqual({
    key: "trigger",
    n8nType: "n8n-nodes-base.manualTrigger",
    typeVersion: 1,
    parameters: {},
    credentials: undefined,
    position: undefined,
  });
  expect(request).toEqual({
    key: "httpRequest_2",
    n8nType: "n8n-nodes-base.httpRequest",
    typeVersion: 1,
    parameters: { method: "GET" },
    credentials: undefined,
    position: undefined,
  });
  expect(edge).toEqual({
    from: "trigger",
    fromOutputIndex: 0,
    to: "httpRequest_2",
    toInputIndex: 0,
    kind: undefined,
  });
});

test("命名規則は変数名を優先し、無ければ <kind>_<counter> を使う", () => {
  expect(createNodeKey({ kind: "set", counter: 1, variableName: "statusNode" })).toBe(
    "statusNode",
  );
  expect(createNodeKey({ kind: "set", counter: 2 })).toBe("set_2");
});

test("決定的 ID 生成は同一入力で同一 ID を返す", () => {
  const payload = {
    kind: "set",
    params: { value: "ok", index: 0 },
  };

  const id1 = createDeterministicId("node", payload);
  const id2 = createDeterministicId("node", payload);

  expect(id1).toBe(id2);
});
