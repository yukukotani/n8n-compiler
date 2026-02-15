import { expect, test } from "bun:test";
import { parseSync } from "../../src/compiler/parse";

test("parseSync は TypeScript を正常解析できる", () => {
  const sourceText = "export const answer: number = 42;";
  const result = parseSync("workflow.ts", sourceText);

  expect(result.diagnostics).toEqual([]);
  expect(result.program).not.toBeNull();

  if (!result.program) {
    throw new Error("program is unexpectedly null");
  }

  expect(result.program.type).toBe("Program");
  expect(result.program.sourceType).toBe("module");

  const firstStatement = result.program.body[0];
  expect(Array.isArray(firstStatement?.range)).toBe(true);
});

test("parseSync は構文エラーを E_PARSE Diagnostic に変換する", () => {
  const sourceText = "export const answer = ;";
  const result = parseSync("broken.ts", sourceText);

  expect(result.program).toBeNull();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics[0]).toMatchObject({
    code: "E_PARSE",
    severity: "error",
    file: "broken.ts",
  });
});
