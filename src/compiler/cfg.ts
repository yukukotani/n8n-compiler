import type {
  Argument,
  ArrowFunctionExpression,
  Comment,
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
import { parseExpressionAsJson, type JsonObject, type JsonValue } from "./ast-json";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";

const SUPPORTED_NODE_CALLS: readonly NodeKind[] = [
  "httpRequest",
  "executeWorkflow",
  "code",
  "aggregate",
  "filter",
  "limit",
  "merge",
  "removeDuplicates",
  "respondToWebhook",
  "sort",
  "splitOut",
  "switch",
  "summarize",
  "set",
  "wait",
  "noOp",
  "googleCalendar",
  "googleSheets",
  "itemLists",
  "langchainAgent",
  "lmChatGoogleVertex",
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
  | CfgForOfStatement
  | CfgParallelStatement
  | CfgConnectStatement;

export type CfgNodeCallStatement = {
  type: "NodeCall";
  call: CfgDslNodeCall;
  displayName?: string;
};

export type CfgVariableStatement = {
  type: "Variable";
  name: string;
  call: CfgDslNodeCall;
  displayName?: string;
};

export type CfgIfStatement = {
  type: "If";
  test: CfgIfTest;
  consequent: CfgStatement[];
  alternate: CfgStatement[];
};

export type CfgForOfSource =
  | { type: "LoopCall"; options: Expression | null }
  | { type: "NodeRef" };

export type CfgForOfStatement = {
  type: "ForOf";
  iteratorName: string;
  source: CfgForOfSource;
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

export type CfgParallelBranch = {
  body: CfgStatement[];
  /** Variable name from destructuring (e.g., `a` in `const [a, b] = n.parallel(...)`) */
  variableName?: string;
  /** Display name for the branch's return node (from @name JSDoc or options.name) */
  displayName?: string;
};

export type CfgParallelStatement = {
  type: "Parallel";
  branches: CfgParallelBranch[];
};

/**
 * Non-main connection statement: `n.connect(sourceNodeCall, targetName, { type })`.
 * Creates a source node that is NOT connected to the main execution flow,
 * and an edge with the specified connection type to the target node.
 */
export type CfgConnectStatement = {
  type: "Connect";
  sourceCall: CfgDslNodeCall;
  sourceDisplayName?: string;
  targetNodeName: string;
  connectionType: string;
};

export type CfgNodeCallOptions = {
  credentials?: Record<string, { id: string; name?: string }>;
  name?: string;
  position?: [number, number];
  typeVersion?: number;
};

export type CfgDslNodeCall = {
  kind: NodeKind;
  parameters: JsonObject;
  options?: CfgNodeCallOptions;
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
  sourceText: string;
  comments: Comment[];
  diagnostics: Diagnostic[];
  /** Maps variable name → display name for $node["..."] serialization */
  nodeVariables: Map<string, string>;
  loopVariables: Set<string>;
  bindings?: ReadonlyMap<string, JsonValue>;
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
  triggerVariableNames?: string[],
  options?: {
    sourceText?: string;
    comments?: Comment[];
    bindings?: ReadonlyMap<string, JsonValue>;
    /** Maps variable name → display name for $node["..."] serialization */
    nodeDisplayNames?: ReadonlyMap<string, string>;
  },
): BuildControlFlowGraphResult {
  const displayNames = options?.nodeDisplayNames;
  const nodeVariables = new Map<string, string>();
  for (const name of triggerVariableNames ?? []) {
    nodeVariables.set(name, displayNames?.get(name) ?? name);
  }

  const context: BuildContext = {
    file,
    sourceText: options?.sourceText ?? "",
    comments: options?.comments ?? [],
    diagnostics: [],
    nodeVariables,
    loopVariables: new Set(),
    bindings: options?.bindings,
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

  const parallelResult = tryBuildParallel(statement.expression, context);
  if (parallelResult) {
    return parallelResult;
  }

  const connectResult = tryBuildConnect(statement.expression, context);
  if (connectResult) {
    return connectResult;
  }

  const nodeCall = toNodeCall(statement.expression, context, {
    start: statement.start,
    end: statement.end,
  });

  if (!nodeCall) {
    return [];
  }

  const displayName = extractJSDocName(statement.start, context);

  return [
    {
      type: "NodeCall",
      call: nodeCall,
      ...(displayName && { displayName }),
    },
  ];
}

function buildVariableDeclaration(
  declaration: VariableDeclaration,
  context: BuildContext,
): CfgStatement[] {
  const statements: CfgStatement[] = [];
  const displayName = extractJSDocName(declaration.start, context);

  for (const declarator of declaration.declarations) {
    if (!declarator.init) {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: "Variable declaration must bind n.<node>(...) call",
        start: declarator.start,
        end: declarator.end,
      });
      continue;
    }

    // Handle const [a, b] = n.parallel(...)
    if (declarator.id.type === "ArrayPattern") {
      const parallelCall = readDslCall(declarator.init);
      if (!parallelCall || parallelCall.name !== "parallel") {
        pushDiagnostic(context, {
          code: "E_UNSUPPORTED_STATEMENT",
          message: "Array destructuring is only supported with n.parallel()",
          start: declarator.start,
          end: declarator.end,
        });
        continue;
      }

      const varNames = declarator.id.elements.map((elem) =>
        elem && elem.type === "Identifier" ? elem.name : undefined,
      );

      const branches = parseParallelBranches(parallelCall, context, varNames);
      if (branches) {
        statements.push({ type: "Parallel", branches });
      }
      continue;
    }

    if (declarator.id.type !== "Identifier") {
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

    context.nodeVariables.set(declarator.id.name, displayName ?? declarator.id.name);

    statements.push({
      type: "Variable",
      name: declarator.id.name,
      call: nodeCall,
      ...(displayName && { displayName }),
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
        }, context.loopVariables)
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
  }, context.loopVariables);
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
  nodeVariables: ReadonlyMap<string, string>,
  options: { allowRawStringLiteral: boolean },
  loopVariables?: ReadonlySet<string>,
): string | null {
  if (options.allowRawStringLiteral && expression.type === "Literal") {
    if (typeof expression.value === "string") {
      return expression.value;
    }
  }

  const body = serializeIfExpressionBody(expression, nodeVariables, loopVariables);
  if (body === null) {
    return null;
  }

  return `={{${body}}}`;
}

function serializeIfExpressionBody(
  expression: Expression,
  nodeVariables: ReadonlyMap<string, string>,
  loopVariables?: ReadonlySet<string>,
): string | null {
  if (expression.type === "Identifier" || expression.type === "MemberExpression") {
    return serializeNodeReferenceExpression(expression, nodeVariables, loopVariables);
  }

  if (expression.type === "Literal") {
    return serializeLiteralValue(expression.value);
  }

  if (expression.type === "ParenthesizedExpression") {
    const inner = serializeIfExpressionBody(expression.expression, nodeVariables, loopVariables);
    if (inner === null) {
      return null;
    }
    return `(${inner})`;
  }

  if (expression.type === "UnaryExpression") {
    if (expression.operator !== "!") {
      return null;
    }

    const argument = serializeIfExpressionBody(expression.argument, nodeVariables, loopVariables);
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

    const left = serializeIfExpressionBody(expression.left, nodeVariables, loopVariables);
    const right = serializeIfExpressionBody(expression.right, nodeVariables, loopVariables);
    if (left === null || right === null) {
      return null;
    }

    return `${left} ${expression.operator} ${right}`;
  }

  if (expression.type === "LogicalExpression") {
    if (!SUPPORTED_IF_LOGICAL_OPERATORS.has(expression.operator)) {
      return null;
    }

    const left = serializeIfExpressionBody(expression.left, nodeVariables, loopVariables);
    const right = serializeIfExpressionBody(expression.right, nodeVariables, loopVariables);
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
  nodeVariables: ReadonlyMap<string, string>,
  loopVariables?: ReadonlySet<string>,
): string | null {
  if (expression.type === "Identifier") {
    if (nodeVariables.has(expression.name)) {
      const displayName = nodeVariables.get(expression.name) ?? expression.name;
      return `$node[${JSON.stringify(displayName)}].json`;
    }
    if (loopVariables?.has(expression.name)) {
      return "$json";
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

  if (current.type !== "Identifier") {
    return null;
  }

  if (nodeVariables.has(current.name)) {
    const displayName = nodeVariables.get(current.name) ?? current.name;
    return `$node[${JSON.stringify(displayName)}].json${segments.join("")}`;
  }

  if (loopVariables?.has(current.name)) {
    return `$json${segments.join("")}`;
  }

  return null;
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

  // Determine source type
  let source: CfgForOfSource;
  const sourceCall = readDslCall(statement.right);
  if (sourceCall?.name === "loop") {
    source = {
      type: "LoopCall",
      options: pickExpressionArgument(sourceCall.arguments[0]),
    };
  } else {
    const nodeRef = serializeNodeReferenceExpression(statement.right, context.nodeVariables);
    if (nodeRef !== null) {
      source = { type: "NodeRef" };
    } else {
      pushDiagnostic(context, {
        code: "E_INVALID_LOOP_SOURCE",
        message: "for...of source must be n.loop(...) or a node reference",
        start: statement.right.start,
        end: statement.right.end,
      });
      return [];
    }
  }

  // Register iterator as loop variable for body scope
  context.loopVariables.add(iterator.id.name);
  const body = buildStatements(toStatementList(statement.body), context);
  context.loopVariables.delete(iterator.id.name);

  return [
    {
      type: "ForOf",
      iteratorName: iterator.id.name,
      source,
      body,
    },
  ];
}

function buildSwitchStatement(statement: SwitchStatement, context: BuildContext): CfgStatement[] {
  const discriminant = buildIfExpressionString(statement.discriminant, context.nodeVariables, {
    allowRawStringLiteral: false,
  }, context.loopVariables);

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
    if (call.name === "expr" || call.name === "loop" || call.name === "parallel") {
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

  const parameters = call.name === "code"
    ? parseCodeNodeParameters(call.arguments, context)
    : parseNodeCallParameters(call.arguments, context.nodeVariables, context.loopVariables, context.bindings);
  const options = parseNodeCallOptions(call.arguments, context.bindings);

  return {
    kind: call.name as NodeKind,
    parameters,
    ...(options && { options }),
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
  nodeVariables: ReadonlyMap<string, string>,
  loopVariables?: ReadonlySet<string>,
  bindings?: ReadonlyMap<string, JsonValue>,
): JsonObject {
  const firstArg = args[0];
  if (!firstArg || firstArg.type === "SpreadElement") {
    return {};
  }

  if (firstArg.type === "ObjectExpression") {
    const parsed = parseExpressionAsJson(firstArg, nodeVariables, loopVariables, bindings);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as JsonObject;
    }
  }

  return {};
}

/**
 * Parse parameters for `n.code(...)` nodes.
 *
 * The `jsCode` property accepts an arrow/function expression whose block body
 * is extracted as a source-text string. All other properties (mode, language,
 * pythonCode, …) are parsed normally via `parseExpressionAsJson`.
 */
function parseCodeNodeParameters(
  args: Argument[],
  context: BuildContext,
): JsonObject {
  const firstArg = args[0];
  if (!firstArg || firstArg.type === "SpreadElement" || firstArg.type !== "ObjectExpression") {
    return {};
  }

  const result: JsonObject = {};

  for (const property of firstArg.properties) {
    if (property.type !== "Property" || property.kind !== "init" || property.method) {
      continue;
    }

    const key = getPropertyKeyName(property.key);
    if (!key) continue;

    if (key === "jsCode") {
      const jsCode = extractJsCodeFromExpression(property.value, context);
      if (jsCode !== null) {
        result.jsCode = jsCode;
      }
      continue;
    }

    const value = parseExpressionAsJson(
      property.value,
      context.nodeVariables,
      context.loopVariables,
      context.bindings,
    );
    if (value !== null) {
      result[key] = value;
    }
  }

  return result;
}

function getPropertyKeyName(key: unknown): string | null {
  if (!key || typeof key !== "object" || !("type" in key)) return null;
  const k = key as { type: string; name?: string; value?: unknown };
  if (k.type === "Identifier" && typeof k.name === "string") return k.name;
  if (k.type === "Literal" && typeof k.value === "string") return k.value;
  return null;
}

function extractJsCodeFromExpression(expression: Expression, context: BuildContext): string | null {
  if (
    expression.type !== "ArrowFunctionExpression" &&
    expression.type !== "FunctionExpression"
  ) {
    return null;
  }

  const fn = expression as unknown as { body: { type: string; start: number; end: number } };
  if (fn.body.type !== "BlockStatement") {
    return null;
  }

  return extractBlockBodyText(context.sourceText, fn.body);
}

/**
 * Extract the source text of a block body (`{ ... }`), stripping the braces
 * and removing the common leading indentation.
 *
 * Single-line bodies return a trimmed string without trailing newline.
 * Multi-line bodies return dedented text with a trailing newline.
 */
function extractBlockBodyText(sourceText: string, body: { start: number; end: number }): string {
  const raw = sourceText.slice(body.start + 1, body.end - 1);

  if (!raw.includes("\n")) {
    return raw.trim();
  }

  const lines = raw.split("\n");

  // Remove first line if empty (newline right after {)
  if (lines.length > 0 && lines[0]!.trim() === "") {
    lines.shift();
  }
  // Remove last line if whitespace-only (indentation before })
  if (lines.length > 0 && lines[lines.length - 1]!.trim() === "") {
    lines.pop();
  }

  if (lines.length === 0) return "";

  // Find minimum indentation among non-empty lines
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const match = line.match(/^(\s*)/);
    if (match) {
      minIndent = Math.min(minIndent, match[1]!.length);
    }
  }
  if (!isFinite(minIndent)) minIndent = 0;

  return lines.map((l) => l.slice(minIndent)).join("\n") + "\n";
}

function pickExpressionArgument(argument: Argument | undefined): Expression | null {
  if (!argument || argument.type === "SpreadElement") {
    return null;
  }

  return argument;
}

/**
 * Try to parse `n.connect(sourceNodeCall, targetName, { type })` as a CfgConnectStatement.
 */
function tryBuildConnect(expression: Expression, context: BuildContext): CfgStatement[] | null {
  const call = readDslCall(expression);
  if (!call || call.name !== "connect") {
    return null;
  }

  if (call.arguments.length < 3) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "n.connect() requires 3 arguments: sourceNodeCall, targetName, { type }",
      start: call.start,
      end: call.end,
    });
    return [];
  }

  // First argument: n.<kind>(...) call for the source node
  const sourceArg = call.arguments[0];
  if (!sourceArg || sourceArg.type === "SpreadElement") {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "n.connect() first argument must be a n.<node>(...) call",
      start: call.start,
      end: call.end,
    });
    return [];
  }

  const sourceNodeCall = toNodeCall(sourceArg, context, {
    start: sourceArg.start,
    end: sourceArg.end,
  });
  if (!sourceNodeCall) {
    return [];
  }

  // Extract display name from options.name of the source node call
  const sourceDisplayName = sourceNodeCall.options?.name;

  // Second argument: target node display name (string literal)
  const targetArg = call.arguments[1];
  if (
    !targetArg ||
    targetArg.type === "SpreadElement" ||
    targetArg.type !== "Literal" ||
    typeof targetArg.value !== "string"
  ) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "n.connect() second argument must be a string literal (target node name)",
      start: targetArg?.start ?? call.start,
      end: targetArg?.end ?? call.end,
    });
    return [];
  }
  const targetNodeName = targetArg.value;

  // Third argument: { type: "ai_languageModel" }
  const optionsArg = call.arguments[2];
  if (
    !optionsArg ||
    optionsArg.type === "SpreadElement" ||
    optionsArg.type !== "ObjectExpression"
  ) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: 'n.connect() third argument must be an object like { type: "ai_languageModel" }',
      start: optionsArg?.start ?? call.start,
      end: optionsArg?.end ?? call.end,
    });
    return [];
  }

  const optionsParsed = parseExpressionAsJson(optionsArg);
  if (!optionsParsed || typeof optionsParsed !== "object" || Array.isArray(optionsParsed)) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "n.connect() options must be a JSON object",
      start: optionsArg.start,
      end: optionsArg.end,
    });
    return [];
  }

  const connectionType = (optionsParsed as Record<string, unknown>).type;
  if (typeof connectionType !== "string") {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: 'n.connect() options must include a "type" string property',
      start: optionsArg.start,
      end: optionsArg.end,
    });
    return [];
  }

  return [
    {
      type: "Connect",
      sourceCall: sourceNodeCall,
      ...(sourceDisplayName && { sourceDisplayName }),
      targetNodeName,
      connectionType,
    },
  ];
}

function tryBuildParallel(expression: Expression, context: BuildContext): CfgStatement[] | null {
  const call = readDslCall(expression);
  if (!call || call.name !== "parallel") {
    return null;
  }

  const branches = parseParallelBranches(call, context);
  if (!branches) {
    return [];
  }

  return [
    {
      type: "Parallel",
      branches,
    },
  ];
}

/**
 * Parse `n.parallel(...)` branches, supporting:
 * - Expression body: `() => n.foo(...)`
 * - Block body: `() => { n.foo(...); ... }`
 *
 * Returns branches, or null on error.
 */
function parseParallelBranches(
  call: DslCall,
  context: BuildContext,
  variableNames?: (string | undefined)[],
): CfgParallelBranch[] | null {
  if (call.arguments.length === 0) {
    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "n.parallel() requires at least one branch",
      start: call.start,
      end: call.end,
    });
    return null;
  }

  const branches: CfgParallelBranch[] = [];

  for (let i = 0; i < call.arguments.length; i++) {
    const arg = call.arguments[i]!;
    const varName = variableNames?.[i];

    if (arg.type === "SpreadElement") {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: "n.parallel() does not support spread arguments",
        start: arg.start,
        end: arg.end,
      });
      return null;
    }

    if (arg.type !== "ArrowFunctionExpression" && arg.type !== "FunctionExpression") {
      pushDiagnostic(context, {
        code: "E_UNSUPPORTED_STATEMENT",
        message: "n.parallel() arguments must be arrow functions or function expressions",
        start: arg.start,
        end: arg.end,
      });
      return null;
    }

    const branch = buildParallelBranch(arg, varName, context);
    branches.push(branch);
  }

  return branches;
}

/**
 * Build a single parallel branch from a callback argument.
 *
 * For expression body (`() => n.foo(...)`) the single call becomes a
 * `CfgVariableStatement` (if `varName` is provided) or `CfgNodeCallStatement`.
 *
 * For block body, existing parsing is used and the last node call is promoted
 * to a `CfgVariableStatement` when a variable name is assigned.
 */
function buildParallelBranch(
  fn: ArrowFunctionExpression | Expression,
  varName: string | undefined,
  context: BuildContext,
): CfgParallelBranch {
  let body: CfgStatement[];
  let displayName: string | undefined;

  if (fn.type === "ArrowFunctionExpression" && fn.expression) {
    // Expression body: () => n.foo(...)
    const nodeCall = toNodeCall(fn.body as Expression, context, {
      start: fn.body.start,
      end: fn.body.end,
    });

    if (nodeCall) {
      displayName = nodeCall.options?.name;
      if (varName) {
        context.nodeVariables.set(varName, displayName ?? varName);
        body = [{
          type: "Variable",
          name: varName,
          call: nodeCall,
          ...(displayName && { displayName }),
        }];
      } else {
        body = [{ type: "NodeCall", call: nodeCall, ...(displayName && { displayName }) }];
      }
    } else {
      body = [];
    }
  } else {
    // Block body (existing path)
    const statements = pickParallelBranchBody(fn, context);
    body = buildStatements(statements, context);

    // If a variable name is assigned from destructuring, promote the last node call
    if (varName && body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.type === "NodeCall") {
        displayName = last.call.options?.name ?? last.displayName;
        context.nodeVariables.set(varName, displayName ?? varName);
        body[body.length - 1] = {
          type: "Variable",
          name: varName,
          call: last.call,
          ...(displayName && { displayName }),
        };
      } else if (last.type === "Variable") {
        displayName = last.displayName ?? last.call.options?.name ?? last.name;
        context.nodeVariables.set(varName, displayName ?? varName);
      }
    }
  }

  return { body, variableName: varName, displayName };
}

function pickParallelBranchBody(
  fn: ArrowFunctionExpression | Expression,
  context: BuildContext,
): Statement[] {
  if (fn.type === "ArrowFunctionExpression") {
    if (fn.body.type === "BlockStatement") {
      return pickFunctionBodyStatements(fn.body);
    }

    pushDiagnostic(context, {
      code: "E_UNSUPPORTED_STATEMENT",
      message: "n.parallel() branch must use a block body",
      start: fn.body.start,
      end: fn.body.end,
    });
    return [];
  }

  if (fn.type === "FunctionExpression") {
    return pickFunctionExpressionBody(fn, context);
  }

  return [];
}

function parseNodeCallOptions(
  args: Argument[],
  bindings?: ReadonlyMap<string, JsonValue>,
): CfgNodeCallOptions | undefined {
  const secondArg = args[1];
  if (!secondArg || secondArg.type === "SpreadElement") {
    return undefined;
  }

  if (secondArg.type !== "ObjectExpression") {
    return undefined;
  }

  const parsed = parseExpressionAsJson(secondArg, undefined, undefined, bindings);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  const options: CfgNodeCallOptions = {};

  if (obj.credentials && typeof obj.credentials === "object" && !Array.isArray(obj.credentials)) {
    options.credentials = obj.credentials as Record<string, { id: string; name?: string }>;
  }

  if (typeof obj.name === "string") {
    options.name = obj.name;
  }

  if (
    Array.isArray(obj.position) &&
    obj.position.length === 2 &&
    typeof obj.position[0] === "number" &&
    typeof obj.position[1] === "number"
  ) {
    options.position = obj.position as [number, number];
  }

  if (typeof obj.typeVersion === "number") {
    options.typeVersion = obj.typeVersion;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Extract `@name` value from a JSDoc block comment immediately preceding the given position.
 *
 * Matches `/** @name Some Display Name *​/` where only whitespace separates comment end and statement start.
 */
function extractJSDocName(statementStart: number, context: BuildContext): string | null {
  // Find block comments that end before (or at) the statement start
  // and have only whitespace between comment end and statement start.
  for (let i = context.comments.length - 1; i >= 0; i--) {
    const comment = context.comments[i]!;
    if (comment.type !== "Block") {
      continue;
    }
    if (comment.end > statementStart) {
      continue;
    }
    // Check that only whitespace exists between comment end and statement start
    const between = context.sourceText.slice(comment.end, statementStart);
    if (between.trim().length > 0) {
      // There's code between the comment and the statement; skip
      continue;
    }
    // Parse @name from the comment value
    // comment.value is the content between /* and */
    const nameMatch = comment.value.match(/@name\s+(.+)/);
    if (nameMatch) {
      return nameMatch[1]!.replace(/\s*\*?\s*$/, "").trim();
    }
    // This is the nearest preceding comment but doesn't have @name
    break;
  }
  return null;
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
