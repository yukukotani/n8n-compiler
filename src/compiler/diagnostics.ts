export const PRIMARY_DIAGNOSTIC_CODES = [
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
] as const;

export type DiagnosticCode = (typeof PRIMARY_DIAGNOSTIC_CODES)[number];
export type DiagnosticSeverity = "error" | "warning";

export type Diagnostic = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  file: string;
  start?: number;
  end?: number;
  hint?: string;
};

type CreateDiagnosticInput = {
  code: DiagnosticCode;
  message: string;
  file: string;
  severity?: DiagnosticSeverity;
  start?: number;
  end?: number;
  hint?: string;
};

export function createDiagnostic(input: CreateDiagnosticInput): Diagnostic {
  return {
    code: input.code,
    severity: input.severity ?? "error",
    message: input.message,
    file: input.file,
    start: input.start,
    end: input.end,
    hint: input.hint,
  };
}

export function createErrorDiagnostic(
  input: Omit<CreateDiagnosticInput, "severity">,
): Diagnostic {
  return createDiagnostic({ ...input, severity: "error" });
}

export function createWarningDiagnostic(
  input: Omit<CreateDiagnosticInput, "severity">,
): Diagnostic {
  return createDiagnostic({ ...input, severity: "warning" });
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const range = formatRange(diagnostic.start, diagnostic.end);
  const location = range ? `${diagnostic.file}:${range}` : diagnostic.file;
  const head = `${diagnostic.severity}[${diagnostic.code}] ${location} ${diagnostic.message}`;

  if (!diagnostic.hint) {
    return head;
  }

  return `${head}\nHint: ${diagnostic.hint}`;
}

function formatRange(start?: number, end?: number): string {
  if (typeof start === "number" && typeof end === "number") {
    return `${start}-${end}`;
  }

  if (typeof start === "number") {
    return `${start}`;
  }

  return "";
}
