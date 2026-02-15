import { expect, test } from "bun:test";
import { compile } from "../../src/compiler/compile";
import { readFixture } from "../helpers/fixtures";
import { expectToMatchSnapshot, stableStringify } from "../helpers/snapshot";

test("compile は同一入力に対して決定的な workflow JSON を返す", () => {
  const sourceText = readFixture("compiler/workflow-determinism/input.workflow.ts");

  const first = compile({
    file: "workflow-determinism.workflow.ts",
    sourceText,
  });
  const second = compile({
    file: "workflow-determinism.workflow.ts",
    sourceText,
  });

  expect(first.diagnostics).toEqual([]);
  expect(second.diagnostics).toEqual([]);
  expect(first.workflow).not.toBeNull();
  expect(second.workflow).not.toBeNull();

  if (!first.workflow || !second.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expect(stableStringify(first.workflow)).toBe(stableStringify(second.workflow));
  expectToMatchSnapshot(first.workflow, "compiler/workflow-determinism/workflow.snapshot.json");
});

test("if/for 混在ワークフローを compile すると統合スナップショットと一致する", () => {
  const sourceText = readFixture("compiler/if-for-mixed/input.workflow.ts");

  const result = compile({
    file: "if-for-mixed.workflow.ts",
    sourceText,
  });

  expect(result.diagnostics).toEqual([]);
  expect(result.workflow).not.toBeNull();

  if (!result.workflow) {
    throw new Error("workflow is unexpectedly null");
  }

  expectToMatchSnapshot(result.workflow, "compiler/if-for-mixed/workflow.snapshot.json");
});

test("未対応構文は diagnostics スナップショットに集約される", () => {
  const sourceText = readFixture("compiler/unsupported-syntax/input.workflow.ts");

  const result = compile({
    file: "unsupported-syntax.workflow.ts",
    sourceText,
  });

  expect(result.workflow).toBeNull();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expectToMatchSnapshot(result.diagnostics, "compiler/unsupported-syntax/diagnostics.snapshot.json");
});
