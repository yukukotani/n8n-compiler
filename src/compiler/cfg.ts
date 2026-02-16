import type {
  Argument,
  ArrowFunctionExpression,
  Expression,
  ForOfStatement,
  Function,
  FunctionBody,
  IfStatement,
  Statement,
  SwitchCase,
  SwitchStatement,
  VariableDeclaration,
} from "oxc-parser";
import type { NodeKind } from "../dsl/types";
import { TRIGGER_NODE_KINDS } from "../dsl";
import { parseExpressionAsJson, type JsonObject } from "./ast-json";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";

const SUPPORTED_NODE_CALLS: readonly NodeKind[] = [
  "httpRequest",
  "aggregate",
  "filter",
  "merge",
  "respondToWebhook",
  "splitOut",
  "switch",
  "set",
  "wait",
  "noOp",
];

const SUPPORTED_NODE_CALL_SET = new Set<string>(SUPPORTED_NODE_CALLS);

export type CfgBlock = {
  type: "Block";
  body: CfgStatement[];
};

export type CfgStatement =
  | CfgBlock
  | CfgNodeCallStatement
  | CfgVariableStatement
  | CfgIfStatement
  | CfgSwitchStatement
  | CfgForOfStatement;

export type CfgNodeCallStatement = {
  type: "NodeCall";
  call: CfgDslNodeCall;
};

export type CfgVariableStatement = {
  type: "Variable";
  name: string;
  call: CfgDslNodeCall;
};

export type CfgIfStatement = {
  type: "If";
  test: CfgIfTest;
  consequent: CfgStatement[];
  alternate: CfgStatement[];
};

export type CfgForOfStatement = {
  type: "ForOf";
  iteratorName: string;
  source: {
    type: "LoopCall";
    options: Expression | null;
  };
  body: CfgStatement[];
};

export type CfgSwitchStatement = {
  type: "Switch";
  discriminant: string;
  cases: CfgSwitchCase[];
  defaultCase: CfgStatement[] | null;
};

export type CfgSwitchCase = {
  test: string | number | boolean | null;
  consequent: CfgStatement[];
};

export type CfgDslNodeCall = {
  kind: NodeKind;
  parameters: JsonObject;
};

export type CfgIfTest =
  | {
      type: "ExprCall";
      expression: string;
    }
  | {
      type: "BooleanLiteral";
      value: boolean;
    };

const SUPPORTED_IF_BINARY_OPERATORS = new Set<string>([
  "==",
  "===",
  "!=",
  "!==",
  ">",
  ">=",
  "<",
  "<=",
]);

const SUPPORTED_IF_LOGICAL_OPERATORS = new Set<string>(["&&", "||"]);

export type BuildControlFlowGraphResult = {
  cfg: CfgBlock | null;
  diagnostics: Diagnostic[];
};

type BuildContext = {
  file: string;
  diagnostics: Diagnostic[];
  nodeVariables: Set<string>;
};

type DslCall = {
  name: string;
  arguments: Argument[];
  start: number;
  end: number;
};

export function buildControlFlowGraph(
  file: string,
  execute: Expression,
): BuildControlFlowGraphResult {
  const context: BuildContext = {
    file,
    diagnostics: [],
    nodeVariables: new Set(),
  };
  const executeBody = pickExecuteBody(execute, context);
  const body = buildStatements(executeBody, context);

  return {
    cfg: context.diagnostics.length > 0 ? null : { type: "Block", body },
    diagnostics: context.diagnostics,
  };
}

function pickExecuteBody(execute: Expression, context: BuildContext): Statement[] {
  if (execute.type === "FunctionExpression") {
    return pickFunctionExpressionBody(execute, context);
  }

  if (execute.type === "ArrowFunctionExpression") {
    if (execute.body.type === "BlockStatement") {
      return pickFunctionBodyStatements(execute.body);
    }

    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "execute function must use a block body",
      start: execute.body.start,
      end: execute.body.end,
    });

    return [];
  }

  pushDiagnostic(context, {
    code: "E_UNSUPPORTED_STATEMENT",
    message: "execute must be a function expression",
    start: execute.start,
    end: execute.end,
  });
  return [];
}

function pickFunctionBodyStatements(body: FunctionBody): Statement[] {
  return body.body.filter((statement): statement is Statement => {
    return statement.type !== "ExpressionStatement" || typeof statement.directive !== "string";
  });
}

function pickFunctionExpressionBody(functionExpression: Function, context: BuildContext): Statement[] {
  if (!functionExpression.body) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "execute function must have a body",
      start: functionExpression.start,
      end: functionExpression.end,
    });
    return [];
  }

  return pickFunctionBodyStatements(functionExpression.body);
}

function buildStatements(statements: Statement[], context: BuildContext): CfgStatement[] {
  const cfgStatements: CfgStatement[] = [];

  for (const statement of statements) {
    cfgStatements.push(...buildStatement(statement, context));
  }

  return cfgStatements;
}

function buildStatement(statement: Statement, context: BuildContext): CfgStatement[] {
  switch (statement.type) {
    case "BlockStatement":
      return [buildBlockStatement(statement.body, context)];
    case "ExpressionStatement":
      return buildExpressionStatement(statement, context);
    case "VariableDeclaration":
      return buildVariableDeclaration(statement, context);
    case "IfStatement":
      return buildIfStatement(statement, context);
    case "SwitchStatement":
      return buildSwitchStatement(statement, context);
    case "ForOfStatement":
      return buildForOfStatement(statement, context);
    default:
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: `Unsupported statement type: ${statement.type}`,
        start: statement.start,
        end: statement.end,
      });
      return [];
  }
}

function buildBlockStatement(statements: Statement[], context: BuildContext): CfgBlock {
  return {
    type: "Block",
    body: buildStatements(statements, context),
  };
}

function buildExpressionStatement(statement: Statement, context: BuildContext): CfgStatement[] {
  if (statement.type !== "ExpressionStatement") {
    return [];
  }

  const nodeCall = toNodeCall(statement.expression, context, {
    start: statement.start,
    end: statement.end,
  });

  if (!nodeCall) {
    return [];
  }

  return [
    {
      type: "NodeCall",
      call: nodeCall,
    },
  ];
}

function buildVariableDeclaration(
  declaration: VariableDeclaration,
  context: BuildContext,
): CfgStatement[] {
  const statements: CfgStatement[] = [];

  for (const declarator of declaration.declarations) {
    if (declarator.id.type !== "Identifier" || !declarator.init) {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: "Variable declaration must bind n.<node>(...) call",
        start: declarator.start,
        end: declarator.end,
      });
      continue;
    }

    const nodeCall = toNodeCall(declarator.init, context, {
      start: declarator.start,
      end: declarator.end,
    });

    if (!nodeCall) {
      continue;
    }

    context.nodeVariables.add(declarator.id.name);

    statements.push({
      type: "Variable",
      name: declarator.id.name,
      call: nodeCall,
    });
  }

  return statements;
}

function buildIfStatement(statement: IfStatement, context: BuildContext): CfgStatement[] {
  const test = buildIfTest(statement.test, context);
  const consequent = buildStatements(toStatementList(statement.consequent), context);
  const alternate = statement.alternate
    ? buildStatements(toStatementList(statement.alternate), context)
    : [];

  if (!test) {
    return [];
  }

  return [
    {
      type: "If",
      test,
      consequent,
      alternate,
    },
  ];
}

function buildIfTest(test: Expression, context: BuildContext): CfgIfTest | null {
  if (test.type === "Literal" && typeof test.value === "boolean") {
    return {
      type: "BooleanLiteral",
      value: test.value,
    };
  }

  const call = readDslCall(test);
  if (call?.name === "expr") {
    const expressionArg = pickExpressionArgument(call.arguments[0]);
    const expression = expressionArg
      ? buildIfExpressionString(expressionArg, context.nodeVariables, {
          allowRawStringLiteral: true,
        })
      : null;
    if (expression !== null) {
      return {
        type: "ExprCall",
        expression,
      };
    }
  }

  const directExpression = buildIfExpressionString(test, context.nodeVariables, {
    allowRawStringLiteral: false,
  });
  if (directExpression !== null) {
    // When the top-level expression is a bare node reference (no comparison/logical/unary operator),
    // wrap with !! to ensure boolean coercion. Without this, n8n's condition check
    // (rightValue: true, operator: { type: "boolean", operation: "true" }) would fail
    // when the value is an object or other non-boolean truthy value.
    const needsBooleanCoercion = test.type === "Identifier" || test.type === "MemberExpression";
    return {
      type: "ExprCall",
      expression: needsBooleanCoercion
        ? `={{!!${directExpression.slice(3, -2)}}}`
        : directExpression,
    };
  }

  pushDiagnostic(context, {
    code: "E_UNSUPPORTED_IF_TEST",
    message: "If test must be n.expr(...) or boolean literal",
    start: test.start,
    end: test.end,
  });
  return null;
}

function buildIfExpressionString(
  expression: Expression,
  nodeVariables: ReadonlySet<string>,
  options: { allowRawStringLiteral: boolean },
): string | null {
  if (options.allowRawStringLiteral && expression.type === "Literal") {
    if (typeof expression.value === "string") {
      return expression.value;
    }
  }

  const body = serializeIfExpressionBody(expression, nodeVariables);
  if (body === null) {
    return null;
  }

  return `={{${body}}}`;
}

function serializeIfExpressionBody(
  expression: Expression,
  nodeVariables: ReadonlySet<string>,
): string | null {
  if (expression.type === "Identifier" || expression.type === "MemberExpression") {
    return serializeNodeReferenceExpression(expression, nodeVariables);
  }

  if (expression.type === "Literal") {
    return serializeLiteralValue(expression.value);
  }

  if (expression.type === "ParenthesizedExpression") {
    const inner = serializeIfExpressionBody(expression.expression, nodeVariables);
    if (inner === null) {
      return null;
    }
    return `(${inner})`;
  }

  if (expression.type === "UnaryExpression") {
    if (expression.operator !== "!") {
      return null;
    }

    const argument = serializeIfExpressionBody(expression.argument, nodeVariables);
    if (argument === null) {
      return null;
    }

    return `!(${argument})`;
  }

  if (expression.type === "BinaryExpression") {
    if (!SUPPORTED_IF_BINARY_OPERATORS.has(expression.operator)) {
      return null;
    }

    if (expression.left.type === "PrivateIdentifier") {
      return null;
    }

    const left = serializeIfExpressionBody(expression.left, nodeVariables);
    const right = serializeIfExpressionBody(expression.right, nodeVariables);
    if (left === null || right === null) {
      return null;
    }

    return `${left} ${expression.operator} ${right}`;
  }

  if (expression.type === "LogicalExpression") {
    if (!SUPPORTED_IF_LOGICAL_OPERATORS.has(expression.operator)) {
      return null;
    }

    const left = serializeIfExpressionBody(expression.left, nodeVariables);
    const right = serializeIfExpressionBody(expression.right, nodeVariables);
    if (left === null || right === null) {
      return null;
    }

    return `${left} ${expression.operator} ${right}`;
  }

  return null;
}

function serializeLiteralValue(value: unknown): string | null {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }
    return String(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  return null;
}

function serializeNodeReferenceExpression(
  expression: Expression,
  nodeVariables: ReadonlySet<string>,
): string | null {
  if (expression.type === "Identifier") {
    if (nodeVariables.has(expression.name)) {
      return `$node[${JSON.stringify(expression.name)}].json`;
    }

    return null;
  }

  if (expression.type !== "MemberExpression") {
    return null;
  }

  const segments: string[] = [];
  let current: Expression = expression;

  while (current.type === "MemberExpression") {
    if (current.computed) {
      if (current.property.type !== "Literal") {
        return null;
      }

      if (typeof current.property.value === "string") {
        segments.unshift(`[${JSON.stringify(current.property.value)}]`);
      } else if (typeof current.property.value === "number") {
        segments.unshift(`[${current.property.value}]`);
      } else {
        return null;
      }
    } else {
      if (current.property.type !== "Identifier") {
        return null;
      }

      segments.unshift(`.${current.property.name}`);
    }

    current = current.object;
  }

  if (current.type !== "Identifier" || !nodeVariables.has(current.name)) {
    return null;
  }

  return `$node[${JSON.stringify(current.name)}].json${segments.join("")}`;
}

function buildForOfStatement(statement: ForOfStatement, context: BuildContext): CfgStatement[] {
  if (statement.await) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_FOR_FORM",
      message: "for await...of is not supported in MVP",
      start: statement.start,
      end: statement.end,
    });
    return [];
  }

  if (statement.left.type !== "VariableDeclaration" || statement.left.kind !== "const") {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_FOR_FORM",
      message: "for...of must use const binding in MVP",
      start: statement.start,
      end: statement.end,
    });
    return [];
  }

  const iterator = statement.left.declarations[0];
  if (
    !iterator ||
    statement.left.declarations.length !== 1 ||
    iterator.id.type !== "Identifier"
  ) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_FOR_FORM",
      message: "for...of must bind exactly one identifier",
      start: statement.start,
      end: statement.end,
    });
    return [];
  }

  const sourceCall = readDslCall(statement.right);
  if (!sourceCall || sourceCall.name !== "loop") {
    pushDiagnostic(context, {
      code: "E_INVALID_LOOP_SOURCE",
      message: "for...of source must be n.loop(...) call",
      start: statement.right.start,
      end: statement.right.end,
    });
    return [];
  }

  return [
    {
      type: "ForOf",
      iteratorName: iterator.id.name,
      source: {
        type: "LoopCall",
        options: pickExpressionArgument(sourceCall.arguments[0]),
      },
      body: buildStatements(toStatementList(statement.body), context),
    },
  ];
}

function buildSwitchStatement(statement: SwitchStatement, context: BuildContext): CfgStatement[] {
  const discriminant = buildIfExpressionString(statement.discriminant, context.nodeVariables, {
    allowRawStringLiteral: false,
  });

  if (discriminant === null) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "switch discriminant must be a serializable expression",
      start: statement.discriminant.start,
      end: statement.discriminant.end,
    });
    return [];
  }

  const cases: CfgSwitchCase[] = [];
  let defaultCase: CfgStatement[] | null = null;

  for (const [index, switchCase] of statement.cases.entries()) {
    const isLast = index === statement.cases.length - 1;
    const caseStatements = buildSwitchCaseConsequent(switchCase, isLast, context);
    if (caseStatements === null) {
      continue;
    }

    if (switchCase.test === null) {
      defaultCase = caseStatements;
      continue;
    }

    const test = toSwitchCaseLiteral(switchCase.test);
    if (test === undefined) {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: "switch case test must be a literal (string/number/boolean/null)",
        start: switchCase.test.start,
        end: switchCase.test.end,
      });
      continue;
    }

    cases.push({
      test,
      consequent: caseStatements,
    });
  }

  return [
    {
      type: "Switch",
      discriminant,
      cases,
      defaultCase,
    },
  ];
}

function buildSwitchCaseConsequent(
  switchCase: SwitchCase,
  isLastCase: boolean,
  context: BuildContext,
): CfgStatement[] | null {
  const consequent = switchCase.consequent;
  const breakIndex = consequent.findIndex((statement) => statement.type === "BreakStatement");

  if (breakIndex >= 0) {
    const breakStatement = consequent[breakIndex];
    if (!breakStatement || breakStatement.type !== "BreakStatement") {
      return null;
    }

    if (breakStatement.label !== null || breakIndex !== consequent.length - 1) {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: "switch case only supports trailing unlabeled break",
        start: breakStatement.start,
        end: breakStatement.end,
      });
      return null;
    }

    return buildStatements(consequent.slice(0, -1), context);
  }

  if (!isLastCase) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "switch case fallthrough is not supported in MVP; add break",
      start: switchCase.start,
      end: switchCase.end,
    });
    return null;
  }

  return buildStatements(consequent, context);
}

function toSwitchCaseLiteral(expression: Expression): string | number | boolean | null | undefined {
  if (expression.type !== "Literal") {
    return undefined;
  }

  if (expression.value === null) {
    return null;
  }

  if (typeof expression.value === "string" || typeof expression.value === "boolean") {
    return expression.value;
  }

  if (typeof expression.value === "number") {
    return Number.isFinite(expression.value) ? expression.value : undefined;
  }

  return undefined;
}

function toStatementList(statement: Statement): Statement[] {
  if (statement.type === "BlockStatement") {
    return statement.body;
  }

  return [statement];
}

function toNodeCall(
  expression: Expression,
  context: BuildContext,
  range: { start: number; end: number },
): CfgDslNodeCall | null {
  const call = readDslCall(expression);
  if (!call) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "Expected n.<node>(...) call",
      start: range.start,
      end: range.end,
    });
    return null;
  }

  if (!SUPPORTED_NODE_CALL_SET.has(call.name)) {
    if (call.name === "expr" || call.name === "loop") {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: `n.${call.name}(...) is not a standalone node call`,
        start: call.start,
        end: call.end,
      });
      return null;
    }

    if (TRIGGER_NODE_KINDS.has(call.name)) {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: `n.${call.name}(...) is a trigger node and must be placed in the triggers array, not inside execute()`,
        start: call.start,
        end: call.end,
      });
      return null;
    }

    pushDiagnostic(context, {
      code: "E_UNKNOWN_NODE_CALL",
      message: `Unknown DSL node call: n.${call.name}(...)`,
      start: call.start,
      end: call.end,
    });
    return null;
  }

  const parameters = parseNodeCallParameters(call.arguments, context.nodeVariables);

  return {
    kind: call.name as NodeKind,
    parameters,
  };
}

function readDslCall(expression: Expression): DslCall | null {
  if (expression.type !== "CallExpression") {
    return null;
  }

  const callee = expression.callee;
  if (callee.type !== "MemberExpression" || callee.computed) {
    return null;
  }

  if (callee.object.type !== "Identifier" || callee.object.name !== "n") {
    return null;
  }

  if (callee.property.type !== "Identifier") {
    return null;
  }

  return {
    name: callee.property.name,
    arguments: expression.arguments,
    start: expression.start,
    end: expression.end,
  };
}

function parseNodeCallParameters(
  args: Argument[],
  nodeVariables: ReadonlySet<string>,
): JsonObject {
  const firstArg = args[0];
  if (!firstArg || firstArg.type === "SpreadElement") {
    return {};
  }

  if (firstArg.type === "ObjectExpression") {
    const parsed = parseExpressionAsJson(firstArg, nodeVariables);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  }

  return {};
}

function pickExpressionArgument(argument: Argument | undefined): Expression | null {
  if (!argument || argument.type === "SpreadElement") {
    return null;
  }

  return argument;
}

function pushDiagnostic(
  context: BuildContext,
  input: {
    code:
      | "E_UNSUPPORTED_STATEMENT"
      | "E_UNSUPPORTED_IF_TEST"
      | "E_UNSUPPORTED_FOR_FORM"
      | "E_INVALID_LOOP_SOURCE"
      | "E_UNKNOWN_NODE_CALL";
    message: string;
    start?: number;
    end?: number;
  },
): void {
  context.diagnostics.push(
    createErrorDiagnostic({
      code: input.code,
      message: input.message,
      file: context.file,
      start: input.start,
      end: input.end,
    }),
  );
}
