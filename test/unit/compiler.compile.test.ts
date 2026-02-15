import { expect, test } from "bun:test";
import { compile } from "../../src/compiler/compile";

test("compile は parse→extract→cfg/lower→validate を統合して workflow JSON を返す", () => {
  const sourceText = `
    export default workflow({
      name: "sample",
      settings: { timezone: "Asia/Tokyo" },
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
  expect(result.workflow.nodes.map((node) => node.key)).toEqual([
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

test("compile は validate diagnostics を集約して workflow を返さない", () => {
  const sourceText = `
    export default workflow({
      name: "invalid-workflow",
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
      code: "E_INVALID_WORKFLOW_SCHEMA",
      file: "invalid.ts",
    }),
  );
});
