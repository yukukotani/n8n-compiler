import type {
  Argument,
  ArrowFunctionExpression,
  Expression,
  ForOfStatement,
  Function,
  FunctionBody,
  IfStatement,
  Statement,
  VariableDeclaration,
} from "oxc-parser";
import type { NodeKind } from "../dsl/types";
import { parseExpressionAsJson, type JsonObject } from "./ast-json";
import { createErrorDiagnostic, type Diagnostic } from "./diagnostics";

const SUPPORTED_NODE_CALLS: readonly NodeKind[] = [
  "manualTrigger",
  "httpRequest",
  "set",
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

export type CfgDslNodeCall = {
  kind: NodeKind;
  parameters: JsonObject;
};

export type CfgIfTest =
  | {
      type: "ExprCall";
      expression: Expression;
    }
  | {
      type: "BooleanLiteral";
      value: boolean;
    };

export type BuildControlFlowGraphResult = {
  cfg: CfgBlock | null;
  diagnostics: Diagnostic[];
};

type BuildContext = {
  file: string;
  diagnostics: Diagnostic[];
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
    const expression = pickExpressionArgument(call.arguments[0]);
    if (expression) {
      return {
        type: "ExprCall",
        expression,
      };
    }
  }

  pushDiagnostic(context, {
    code: "E_UNSUPPORTED_IF_TEST",
    message: "If test must be n.expr(...) or boolean literal",
    start: test.start,
    end: test.end,
  });
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

    pushDiagnostic(context, {
      code: "E_UNKNOWN_NODE_CALL",
      message: `Unknown DSL node call: n.${call.name}(...)`,
      start: call.start,
      end: call.end,
    });
    return null;
  }

  const parameters = parseNodeCallParameters(call.arguments);

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

function parseNodeCallParameters(args: Argument[]): JsonObject {
  const firstArg = args[0];
  if (!firstArg || firstArg.type === "SpreadElement") {
    return {};
  }

  if (firstArg.type === "ObjectExpression") {
    const parsed = parseExpressionAsJson(firstArg);
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
