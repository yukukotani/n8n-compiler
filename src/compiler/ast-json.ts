import type { Argument, ArrayExpression, Expression, ObjectExpression, TemplateLiteral } from "oxc-parser";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function parseExpressionAsJson(
  expression: Expression,
  nodeVariables?: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
  bindings?: ReadonlyMap<string, JsonValue>,
): JsonValue | null {
  if (nodeVariables || loopVariables) {
    const ref = tryResolveReference(expression, nodeVariables ?? new Set(), loopVariables);
    if (ref !== null) {
      return ref;
    }
  }

  // Resolve top-level const bindings (e.g. `const foo = { ... }` referenced as `foo`)
  if (expression.type === "Identifier" && bindings?.has(expression.name)) {
    return bindings.get(expression.name)!;
  }

  if (expression.type === "Literal") {
    const value = expression.value;
    if (value === null) {
      return null;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    return null;
  }

  if (expression.type === "ObjectExpression") {
    return parseObjectExpression(expression, nodeVariables, loopVariables, bindings);
  }

  if (expression.type === "ArrayExpression") {
    return parseArrayExpression(expression, nodeVariables, loopVariables, bindings);
  }

  if (expression.type === "TemplateLiteral") {
    return resolveTemplateLiteral(expression, nodeVariables ?? new Set(), loopVariables);
  }

  // Fallback: serialize compound expressions (CallExpression, BinaryExpression, etc.)
  // as n8n expression strings ={{...}}
  if (isCompoundExpression(expression)) {
    const body = serializeExpressionBody(expression, nodeVariables ?? new Set(), loopVariables);
    if (body !== null) {
      return `={{${body}}}`;
    }
  }

  return null;
}

export function parseObjectExpression(
  expression: ObjectExpression,
  nodeVariables?: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
  bindings?: ReadonlyMap<string, JsonValue>,
): JsonObject | null {
  const result: JsonObject = {};

  for (const property of expression.properties) {
    if (property.type !== "Property" || property.kind !== "init" || property.method) {
      return null;
    }

    const key = parsePropertyKey(property.key);
    if (!key) {
      return null;
    }

    const value = parseExpressionAsJson(property.value, nodeVariables, loopVariables, bindings);
    if (value === null && !isNullLiteral(property.value)) {
      return null;
    }

    result[key] = value;
  }

  return result;
}

function parseArrayExpression(
  expression: ArrayExpression,
  nodeVariables?: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
  bindings?: ReadonlyMap<string, JsonValue>,
): JsonValue[] | null {
  const result: JsonValue[] = [];

  for (const element of expression.elements) {
    if (!element || element.type === "SpreadElement") {
      return null;
    }

    const value = parseExpressionAsJson(element, nodeVariables, loopVariables, bindings);
    if (value === null && !isNullLiteral(element)) {
      return null;
    }

    result.push(value);
  }

  return result;
}

/**
 * Resolves an AST expression that references a node or loop variable into an n8n expression string.
 *
 * Node variables:
 * - `res`          → `={{$node["res"].json}}`
 * - `res.data`     → `={{$node["res"].json.data}}`
 * - `res["key"]`   → `={{$node["res"].json["key"]}}`
 *
 * Loop variables:
 * - `item`         → `={{$json}}`
 * - `item.name`    → `={{$json.name}}`
 * - `item["key"]`  → `={{$json["key"]}}`
 */
function tryResolveReference(
  expression: Expression,
  nodeVariables: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
): string | null {
  const body = resolveReferenceBody(expression, nodeVariables, loopVariables);
  if (body === null) {
    return null;
  }
  return `={{${body}}}`;
}

/**
 * Resolves an AST expression to the body of an n8n expression (without `={{...}}` wrapper).
 *
 * Node variables: `res.data` → `$node["res"].json.data`
 * Loop variables: `item.name` → `$json.name`
 */
export function resolveReferenceBody(
  expression: Expression,
  nodeVariables: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
): string | null {
  if (expression.type === "Identifier") {
    if (nodeVariables.has(expression.name)) {
      return `$node["${expression.name}"].json`;
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
      if (current.property.type === "Literal") {
        if (typeof current.property.value === "string") {
          segments.unshift(`["${current.property.value}"]`);
        } else if (typeof current.property.value === "number") {
          segments.unshift(`[${current.property.value}]`);
        } else {
          return null;
        }
      } else {
        return null;
      }
    } else {
      if (current.property.type === "Identifier") {
        segments.unshift(`.${current.property.name}`);
      } else {
        return null;
      }
    }
    current = current.object;
  }

  if (current.type !== "Identifier") {
    return null;
  }

  if (nodeVariables.has(current.name)) {
    return `$node["${current.name}"].json${segments.join("")}`;
  }

  if (loopVariables?.has(current.name)) {
    return `$json${segments.join("")}`;
  }

  return null;
}

/**
 * Resolves a template literal into an n8n expression string.
 *
 * - No expressions: `` `hello` `` → `"hello"` (plain string)
 * - With expressions: `` `https://example.com/${item.name}` ``
 *   → `` ={{`https://example.com/${$json.name}`}} ``
 */
function resolveTemplateLiteral(
  expression: TemplateLiteral,
  nodeVariables: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
): string | null {
  // No expressions → just a plain string
  if (expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? null;
  }

  // Build the inner template literal with resolved expressions
  let inner = "";
  for (let i = 0; i < expression.quasis.length; i++) {
    const quasi = expression.quasis[i];
    if (!quasi) {
      return null;
    }

    // Use raw to preserve escape sequences (backtick escapes, etc.)
    inner += quasi.value.raw;

    if (i < expression.expressions.length) {
      const expr = expression.expressions[i];
      if (!expr) {
        return null;
      }

      const body = resolveReferenceBody(expr, nodeVariables, loopVariables);
      if (body === null) {
        return null;
      }

      inner += "${" + body + "}";
    }
  }

  return "={{`" + inner + "`}}";
}

function parsePropertyKey(key: unknown): string | null {
  if (!key || typeof key !== "object" || !("type" in key)) {
    return null;
  }

  if (key.type === "Identifier" && "name" in key && typeof key.name === "string") {
    return key.name;
  }

  if (key.type === "Literal" && "value" in key && typeof key.value === "string") {
    return key.value;
  }

  return null;
}

function isNullLiteral(expression: Expression): boolean {
  return expression.type === "Literal" && expression.value === null;
}

/**
 * Checks whether an AST expression is a "compound" expression that should be
 * serialized as an n8n expression string when it appears as a parameter value.
 *
 * Compound expressions include function calls, arithmetic, logical operators, etc.
 * Simple identifiers and member expressions that are not node/loop variable references
 * are excluded to preserve existing behavior (they return null, causing a parse failure).
 */
function isCompoundExpression(expression: Expression): boolean {
  switch (expression.type) {
    case "CallExpression":
    case "NewExpression":
    case "BinaryExpression":
    case "UnaryExpression":
    case "LogicalExpression":
    case "ConditionalExpression":
    case "ParenthesizedExpression":
      return true;
    default:
      return false;
  }
}

/**
 * Serializes an AST expression to a JavaScript expression string,
 * resolving node/loop variable references to n8n expression syntax.
 *
 * Used internally to convert compound expressions (CallExpression, etc.)
 * into the body of n8n expression strings (without the `={{...}}` wrapper).
 *
 * Examples:
 * - `JSON.stringify({ pong: true })` → `JSON.stringify({ pong: true })`
 * - `encodeURIComponent(item.name)` → `encodeURIComponent($json.name)` (if `item` is loop var)
 * - `webhook.body.id` → `$node["webhook"].json.body.id` (if `webhook` is node var)
 *
 * Returns null if the expression cannot be serialized.
 */
function serializeExpressionBody(
  expression: Expression,
  nodeVariables: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
): string | null {
  // Resolve node/loop variable references first
  const ref = resolveReferenceBody(expression, nodeVariables, loopVariables);
  if (ref !== null) {
    return ref;
  }

  switch (expression.type) {
    case "Identifier":
      return expression.name;

    case "Literal": {
      if (expression.value === null) return "null";
      if (typeof expression.value === "string") return JSON.stringify(expression.value);
      if (typeof expression.value === "number") {
        return Number.isFinite(expression.value) ? String(expression.value) : null;
      }
      if (typeof expression.value === "boolean") return String(expression.value);
      return null;
    }

    case "MemberExpression": {
      const obj = serializeExpressionBody(expression.object, nodeVariables, loopVariables);
      if (obj === null) return null;
      if (expression.computed) {
        const prop = serializeExpressionBody(expression.property as Expression, nodeVariables, loopVariables);
        if (prop === null) return null;
        return `${obj}[${prop}]`;
      }
      if (expression.property.type === "Identifier") {
        return `${obj}.${expression.property.name}`;
      }
      return null;
    }

    case "CallExpression": {
      const callee = serializeExpressionBody(expression.callee as Expression, nodeVariables, loopVariables);
      if (callee === null) return null;
      const args = serializeArgumentList(expression.arguments, nodeVariables, loopVariables);
      if (args === null) return null;
      return `${callee}(${args})`;
    }

    case "NewExpression": {
      const callee = serializeExpressionBody(expression.callee as Expression, nodeVariables, loopVariables);
      if (callee === null) return null;
      const args = serializeArgumentList(expression.arguments, nodeVariables, loopVariables);
      if (args === null) return null;
      return `new ${callee}(${args})`;
    }

    case "ObjectExpression": {
      const props: string[] = [];
      for (const prop of expression.properties) {
        if (prop.type === "SpreadElement") {
          const inner = serializeExpressionBody(prop.argument, nodeVariables, loopVariables);
          if (inner === null) return null;
          props.push(`...${inner}`);
          continue;
        }
        if (prop.type !== "Property" || prop.kind !== "init" || prop.method) return null;

        const value = serializeExpressionBody(prop.value, nodeVariables, loopVariables);
        if (value === null) return null;

        if (prop.shorthand) {
          if (prop.key.type !== "Identifier") return null;
          props.push(prop.key.name);
        } else if (prop.computed) {
          const key = serializeExpressionBody(prop.key as Expression, nodeVariables, loopVariables);
          if (key === null) return null;
          props.push(`[${key}]: ${value}`);
        } else {
          let keyStr: string | null = null;
          if (prop.key.type === "Identifier") {
            keyStr = prop.key.name;
          } else if (prop.key.type === "Literal") {
            if (typeof prop.key.value === "string") keyStr = JSON.stringify(prop.key.value);
            else if (typeof prop.key.value === "number") keyStr = String(prop.key.value);
          }
          if (keyStr === null) return null;
          props.push(`${keyStr}: ${value}`);
        }
      }
      return `{ ${props.join(", ")} }`;
    }

    case "ArrayExpression": {
      const elements: string[] = [];
      for (const elem of expression.elements) {
        if (!elem) {
          elements.push("");
          continue;
        }
        if (elem.type === "SpreadElement") {
          const inner = serializeExpressionBody(elem.argument, nodeVariables, loopVariables);
          if (inner === null) return null;
          elements.push(`...${inner}`);
        } else {
          const serialized = serializeExpressionBody(elem, nodeVariables, loopVariables);
          if (serialized === null) return null;
          elements.push(serialized);
        }
      }
      return `[${elements.join(", ")}]`;
    }

    case "TemplateLiteral": {
      let result = "`";
      for (let i = 0; i < expression.quasis.length; i++) {
        const quasi = expression.quasis[i];
        if (!quasi) return null;
        result += quasi.value.raw;
        if (i < expression.expressions.length) {
          const expr = expression.expressions[i];
          if (!expr) return null;
          const body = serializeExpressionBody(expr, nodeVariables, loopVariables);
          if (body === null) return null;
          result += "${" + body + "}";
        }
      }
      result += "`";
      return result;
    }

    case "UnaryExpression": {
      const argument = serializeExpressionBody(expression.argument, nodeVariables, loopVariables);
      if (argument === null) return null;
      const op = expression.operator;
      if (op === "typeof" || op === "void" || op === "delete") {
        return `${op} ${argument}`;
      }
      return `${op}${argument}`;
    }

    case "BinaryExpression": {
      if (expression.left.type === "PrivateIdentifier") return null;
      const left = serializeExpressionBody(expression.left, nodeVariables, loopVariables);
      const right = serializeExpressionBody(expression.right, nodeVariables, loopVariables);
      if (left === null || right === null) return null;
      return `${left} ${expression.operator} ${right}`;
    }

    case "LogicalExpression": {
      const left = serializeExpressionBody(expression.left, nodeVariables, loopVariables);
      const right = serializeExpressionBody(expression.right, nodeVariables, loopVariables);
      if (left === null || right === null) return null;
      return `${left} ${expression.operator} ${right}`;
    }

    case "ConditionalExpression": {
      const test = serializeExpressionBody(expression.test, nodeVariables, loopVariables);
      const consequent = serializeExpressionBody(expression.consequent, nodeVariables, loopVariables);
      const alternate = serializeExpressionBody(expression.alternate, nodeVariables, loopVariables);
      if (test === null || consequent === null || alternate === null) return null;
      return `${test} ? ${consequent} : ${alternate}`;
    }

    case "ParenthesizedExpression": {
      const inner = serializeExpressionBody(expression.expression, nodeVariables, loopVariables);
      if (inner === null) return null;
      return `(${inner})`;
    }

    default:
      return null;
  }
}

function serializeArgumentList(
  args: Argument[],
  nodeVariables: ReadonlySet<string>,
  loopVariables?: ReadonlySet<string>,
): string | null {
  const parts: string[] = [];
  for (const arg of args) {
    if (arg.type === "SpreadElement") {
      const inner = serializeExpressionBody(arg.argument, nodeVariables, loopVariables);
      if (inner === null) return null;
      parts.push(`...${inner}`);
    } else {
      const serialized = serializeExpressionBody(arg, nodeVariables, loopVariables);
      if (serialized === null) return null;
      parts.push(serialized);
    }
  }
  return parts.join(", ");
}
