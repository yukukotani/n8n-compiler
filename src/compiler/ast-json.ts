import type { ArrayExpression, Expression, ObjectExpression, TemplateLiteral } from "oxc-parser";

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
