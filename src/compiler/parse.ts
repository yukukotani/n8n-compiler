import {
  parseSync as oxcParseSync,
  type Comment,
  type OxcError,
  type ParserOptions,
  type Program,
} from "oxc-parser";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";

const PARSE_OPTIONS = {
  lang: "ts",
  sourceType: "module",
  range: true,
  showSemanticErrors: true,
} as const satisfies ParserOptions;

export type ParseSyncResult = {
  program: Program | null;
  comments: Comment[];
  diagnostics: Diagnostic[];
};

export function parseSync(file: string, sourceText: string): ParseSyncResult {
  try {
    const parseResult = oxcParseSync(file, sourceText, PARSE_OPTIONS);
    const diagnostics = toParseDiagnostics(file, parseResult.errors);

    if (diagnostics.length > 0) {
      return { program: null, comments: [], diagnostics };
    }

    return {
      program: parseResult.program,
      comments: parseResult.comments,
      diagnostics: [],
    };
  } catch (error) {
    return {
      program: null,
      comments: [],
      diagnostics: [toUnexpectedParseDiagnostic(file, error)],
    };
  }
}

function toParseDiagnostics(file: string, errors: OxcError[]): Diagnostic[] {
  return errors.map((error) => {
    const [start, end] = pickRange(error);

    return createErrorDiagnostic({
      code: "E_PARSE",
      message: error.message,
      file,
      start,
      end,
      hint: error.helpMessage ?? undefined,
    });
  });
}

function toUnexpectedParseDiagnostic(file: string, error: unknown): Diagnostic {
  return createErrorDiagnostic({
    code: "E_PARSE",
    message: resolveErrorMessage(error),
    file,
  });
}

function pickRange(error: OxcError): [number | undefined, number | undefined] {
  const firstLabel = error.labels[0];
  if (!firstLabel) {
    return [undefined, undefined];
  }

  return [firstLabel.start, firstLabel.end];
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Failed to parse source";
}
