import type { JsonObject } from "./ast-json";

/**
 * Transforms DSL-level parameters into n8n-compatible parameters
 * based on the node type and typeVersion.
 *
 * The DSL uses a simplified, user-friendly parameter format.
 * n8n nodes expect specific parameter schemas that differ per node type and version.
 */
export function transformParameters(
  n8nType: string,
  typeVersion: number,
  dslParams: JsonObject,
): JsonObject {
  const transformer = TRANSFORMERS[n8nType];
  if (!transformer) {
    return dslParams;
  }

  return transformer(typeVersion, dslParams);
}

type ParamTransformer = (typeVersion: number, params: JsonObject) => JsonObject;

const TRANSFORMERS: Record<string, ParamTransformer> = {
  "n8n-nodes-base.httpRequest": transformHttpRequest,
  "n8n-nodes-base.set": transformSet,
};

/**
 * HttpRequest v1 uses `requestMethod` instead of `method`.
 *
 * DSL:  { method: "GET", url: "https://..." }
 * n8n:  { requestMethod: "GET", url: "https://..." }
 */
function transformHttpRequest(_typeVersion: number, params: JsonObject): JsonObject {
  const result = { ...params };

  if ("method" in result) {
    result.requestMethod = result.method;
    delete result.method;
  }

  return result;
}

/**
 * Set v1/v2 uses a fixedCollection format for `values`.
 *
 * DSL:  { values: { status: "ok", count: 42, active: true } }
 * n8n:  { values: { string: [{ name: "status", value: "ok" }],
 *                    number: [{ name: "count", value: 42 }],
 *                    boolean: [{ name: "active", value: true }] } }
 */
function transformSet(_typeVersion: number, params: JsonObject): JsonObject {
  const result = { ...params };

  if ("values" in result && isPlainObject(result.values)) {
    result.values = transformSetValues(result.values as Record<string, unknown>) as unknown as JsonObject[keyof JsonObject];
  }

  return result;
}

type SetFixedCollectionEntry = { name: string; value: unknown };

function transformSetValues(
  values: Record<string, unknown>,
): Record<string, SetFixedCollectionEntry[]> {
  const stringEntries: SetFixedCollectionEntry[] = [];
  const numberEntries: SetFixedCollectionEntry[] = [];
  const booleanEntries: SetFixedCollectionEntry[] = [];

  for (const [name, value] of Object.entries(values)) {
    switch (typeof value) {
      case "number":
        numberEntries.push({ name, value });
        break;
      case "boolean":
        booleanEntries.push({ name, value });
        break;
      default:
        // strings, null, objects, etc. all go into string entries
        stringEntries.push({ name, value: String(value) });
        break;
    }
  }

  const result: Record<string, SetFixedCollectionEntry[]> = {};

  if (stringEntries.length > 0) {
    result.string = stringEntries;
  }
  if (numberEntries.length > 0) {
    result.number = numberEntries;
  }
  if (booleanEntries.length > 0) {
    result.boolean = booleanEntries;
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
