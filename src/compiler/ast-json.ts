import type { ArrayExpression, Expression, ObjectExpression } from "oxc-parser";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function parseExpressionAsJson(
  expression: Expression,
  nodeVariables?: ReadonlySet<string>,
): JsonValue | null {
  if (nodeVariables) {
    const ref = tryResolveNodeReference(expression, nodeVariables);
    if (ref !== null) {
      return ref;
    }
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
    return parseObjectExpression(expression, nodeVariables);
  }

  if (expression.type === "ArrayExpression") {
    return parseArrayExpression(expression, nodeVariables);
  }

  return null;
}

export function parseObjectExpression(
  expression: ObjectExpression,
  nodeVariables?: ReadonlySet<string>,
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

    const value = parseExpressionAsJson(property.value, nodeVariables);
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
): JsonValue[] | null {
  const result: JsonValue[] = [];

  for (const element of expression.elements) {
    if (!element || element.type === "SpreadElement") {
      return null;
    }

    const value = parseExpressionAsJson(element, nodeVariables);
    if (value === null && !isNullLiteral(element)) {
      return null;
    }

    result.push(value);
  }

  return result;
}

/**
 * Resolves an AST expression that references a node variable into an n8n expression string.
 *
 * - `res`          → `={{$node["res"].json}}`
 * - `res.data`     → `={{$node["res"].json.data}}`
 * - `res.data.id`  → `={{$node["res"].json.data.id}}`
 * - `res["key"]`   → `={{$node["res"].json["key"]}}`
 * - `res[0]`       → `={{$node["res"].json[0]}}`
 */
function tryResolveNodeReference(
  expression: Expression,
  nodeVariables: ReadonlySet<string>,
): string | null {
  if (expression.type === "Identifier") {
    if (nodeVariables.has(expression.name)) {
      return `={{$node["${expression.name}"].json}}`;
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

  if (current.type !== "Identifier" || !nodeVariables.has(current.name)) {
    return null;
  }

  return `={{$node["${current.name}"].json${segments.join("")}}}`;
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
