import { expect, test } from "bun:test";
import {
  PRIMARY_DIAGNOSTIC_CODES,
  createDiagnostic,
  createErrorDiagnostic,
  createWarningDiagnostic,
  formatDiagnostic,
} from "../../src/compiler/diagnostics";

test("主要 Diagnostic コードが定義されている", () => {
  expect(PRIMARY_DIAGNOSTIC_CODES).toEqual([
    "E_PARSE",
    "E_ENTRY_NOT_FOUND",
    "E_EXECUTE_NOT_FOUND",
    "E_UNSUPPORTED_STATEMENT",
    "E_UNSUPPORTED_IF_TEST",
    "E_UNSUPPORTED_FOR_FORM",
    "E_INVALID_LOOP_SOURCE",
    "E_UNKNOWN_NODE_CALL",
    "E_INVALID_CONNECTION",
    "E_INVALID_WORKFLOW_SCHEMA",
    "E_API_UNAUTHORIZED",
    "E_API_CONFLICT",
    "E_API_NETWORK",
  ]);
});

test("createDiagnostic は Diagnostic 形状を返す", () => {
  const diagnostic = createDiagnostic({
    code: "E_PARSE",
    message: "Failed to parse source",
    file: "src/workflow.ts",
    start: 10,
    end: 18,
  });

  expect(diagnostic).toEqual({
    code: "E_PARSE",
    severity: "error",
    message: "Failed to parse source",
    file: "src/workflow.ts",
    start: 10,
    end: 18,
  });
});

test("formatDiagnostic は人間向けメッセージを整形する", () => {
  const formatted = formatDiagnostic(
    createDiagnostic({
      code: "E_UNSUPPORTED_STATEMENT",
      severity: "warning",
      message: "Statement is ignored",
      file: "src/workflow.ts",
      start: 5,
      end: 12,
      hint: "Use if/for..of only in MVP",
    }),
  );

  expect(formatted).toBe(
    "warning[E_UNSUPPORTED_STATEMENT] src/workflow.ts:5-12 Statement is ignored\nHint: Use if/for..of only in MVP",
  );
});

test("warning/error ヘルパは createDiagnostic に統一される", () => {
  const errorDiagnostic = createErrorDiagnostic({
    code: "E_PARSE",
    message: "Parse failed",
    file: "src/workflow.ts",
  });
  const warningDiagnostic = createWarningDiagnostic({
    code: "E_UNSUPPORTED_STATEMENT",
    message: "Ignored",
    file: "src/workflow.ts",
  });

  expect(errorDiagnostic.severity).toBe("error");
  expect(warningDiagnostic.severity).toBe("warning");
});
