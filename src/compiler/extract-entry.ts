import type {
  CallExpression,
  Expression,
  ExportDefaultDeclaration,
  ObjectExpression,
  ObjectProperty,
  Program,
} from "oxc-parser";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";

type ExecuteExpression = Expression;

export type ExtractedEntry = {
  name: Expression;
  settings: Expression | null;
  execute: ExecuteExpression;
};

export type ExtractEntryResult = {
  entry: ExtractedEntry | null;
  diagnostics: Diagnostic[];
};

export function extractEntry(file: string, program: Program): ExtractEntryResult {
  const workflowCall = findWorkflowDefaultCall(program);
  if (!workflowCall) {
    return {
      entry: null,
      diagnostics: [
        createErrorDiagnostic({
          code: "E_ENTRY_NOT_FOUND",
          message: "export default workflow({...}) was not found",
          file,
        }),
      ],
    };
  }

  const entryObject = pickWorkflowObjectArgument(workflowCall);
  if (!entryObject) {
    return {
      entry: null,
      diagnostics: [
        createErrorDiagnostic({
          code: "E_ENTRY_NOT_FOUND",
          message: "workflow call must receive an object literal argument",
          file,
          start: workflowCall.start,
          end: workflowCall.end,
        }),
      ],
    };
  }

  const name = findObjectPropertyValue(entryObject, "name");
  const settings = findObjectPropertyValue(entryObject, "settings");
  const execute = findObjectPropertyValue(entryObject, "execute");

  if (!name) {
    return {
      entry: null,
      diagnostics: [
        createErrorDiagnostic({
          code: "E_ENTRY_NOT_FOUND",
          message: "workflow object must include name",
          file,
          start: entryObject.start,
          end: entryObject.end,
        }),
      ],
    };
  }

  if (!isExecuteExpression(execute)) {
    return {
      entry: null,
      diagnostics: [
        createErrorDiagnostic({
          code: "E_EXECUTE_NOT_FOUND",
          message: "workflow object must include execute function",
          file,
          start: entryObject.start,
          end: entryObject.end,
        }),
      ],
    };
  }

  return {
    entry: {
      name,
      settings,
      execute,
    },
    diagnostics: [],
  };
}

function findWorkflowDefaultCall(program: Program): CallExpression | null {
  const defaultDeclaration = findExportDefaultDeclaration(program);
  if (!defaultDeclaration) {
    return null;
  }

  return pickWorkflowCall(defaultDeclaration);
}

function findExportDefaultDeclaration(
  program: Program,
): ExportDefaultDeclaration | null {
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      return statement;
    }
  }

  return null;
}

function pickWorkflowCall(
  declaration: ExportDefaultDeclaration,
): CallExpression | null {
  if (declaration.declaration.type !== "CallExpression") {
    return null;
  }

  const callExpression = declaration.declaration;
  if (callExpression.callee.type !== "Identifier") {
    return null;
  }

  if (callExpression.callee.name !== "workflow") {
    return null;
  }

  return callExpression;
}

function pickWorkflowObjectArgument(
  callExpression: CallExpression,
): ObjectExpression | null {
  const firstArg = callExpression.arguments[0];
  if (!firstArg || firstArg.type !== "ObjectExpression") {
    return null;
  }

  return firstArg;
}

function findObjectPropertyValue(
  objectExpression: ObjectExpression,
  name: string,
): Expression | null {
  const property = findObjectProperty(objectExpression, name);
  if (!property) {
    return null;
  }

  return property.value;
}

function findObjectProperty(
  objectExpression: ObjectExpression,
  name: string,
): ObjectProperty | null {
  for (const property of objectExpression.properties) {
    if (property.type !== "Property") {
      continue;
    }

    if (property.key.type !== "Identifier") {
      continue;
    }

    if (property.key.name === name) {
      return property;
    }
  }

  return null;
}

function isExecuteExpression(expression: Expression | null): expression is ExecuteExpression {
  if (!expression) {
    return false;
  }

  return (
    expression.type === "ArrowFunctionExpression" ||
    expression.type === "FunctionExpression"
  );
}
