import { expect, test } from "bun:test";
import { extractEntry } from "../../src/compiler/extract-entry";
import { parseSync } from "../../src/compiler/parse";

test("extractEntry は export default workflow({...}) から主要フィールドを抽出する", () => {
  const sourceText = `
    export default workflow({
      name: "Sample",
      settings: {},
      execute: () => {
        return;
      },
    });
  `;
  const parseResult = parseSync("workflow.ts", sourceText);

  expect(parseResult.diagnostics).toEqual([]);
  expect(parseResult.program).not.toBeNull();

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const result = extractEntry("workflow.ts", parseResult.program);

  expect(result.diagnostics).toEqual([]);
  expect(result.entry).not.toBeNull();

  if (!result.entry) {
    throw new Error("entry is unexpectedly null");
  }

  if (!result.entry.settings) {
    throw new Error("settings is unexpectedly null");
  }

  expect(result.entry.name.type).toBe("Literal");
  expect(result.entry.settings.type).toBe("ObjectExpression");
  expect(result.entry.execute.type).toBe("ArrowFunctionExpression");
});

test("extractEntry はエントリが見つからない場合 E_ENTRY_NOT_FOUND を返す", () => {
  const sourceText = "export const answer = 42;";
  const parseResult = parseSync("no-entry.ts", sourceText);

  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const result = extractEntry("no-entry.ts", parseResult.program);

  expect(result.entry).toBeNull();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "E_ENTRY_NOT_FOUND",
      severity: "error",
      file: "no-entry.ts",
    }),
  ]);
});

test("extractEntry は execute が無い場合 E_EXECUTE_NOT_FOUND を返す", () => {
  const sourceText = `
    export default workflow({
      name: "Sample",
      settings: {},
    });
  `;
  const parseResult = parseSync("no-execute.ts", sourceText);

  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const result = extractEntry("no-execute.ts", parseResult.program);

  expect(result.entry).toBeNull();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "E_EXECUTE_NOT_FOUND",
      severity: "error",
      file: "no-execute.ts",
    }),
  ]);
});

test("extractEntry は settings が無くても抽出できる", () => {
  const sourceText = `
    export default workflow({
      name: "Sample",
      execute: () => {
        return;
      },
    });
  `;
  const parseResult = parseSync("no-settings.ts", sourceText);

  expect(parseResult.diagnostics).toEqual([]);

  if (!parseResult.program) {
    throw new Error("program is unexpectedly null");
  }

  const result = extractEntry("no-settings.ts", parseResult.program);

  expect(result.diagnostics).toEqual([]);
  expect(result.entry).not.toBeNull();

  if (!result.entry) {
    throw new Error("entry is unexpectedly null");
  }

  expect(result.entry.settings).toBeNull();
});
