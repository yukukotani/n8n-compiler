type NodeKeyInput = {
  kind: string;
  counter: number;
  variableName?: string;
};

export function createNodeKey(input: NodeKeyInput): string {
  const normalizedVariableName = normalizeVariableName(input.variableName);
  if (normalizedVariableName) {
    return normalizedVariableName;
  }

  return `${input.kind}_${input.counter}`;
}

export function createDeterministicId(prefix: string, payload: unknown): string {
  const serialized = stableSerialize(payload);
  const hash = fnv1a(serialized);
  return `${prefix}_${hash}`;
}

function normalizeVariableName(value?: string): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .replaceAll(/[^A-Za-z0-9_]+/g, "_")
    .replaceAll(/_+/g, "_")
    .replaceAll(/^_+|_+$/g, "");

  if (!normalized) {
    return null;
  }

  return normalized;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    const serializedEntries = entries.map(
      ([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`,
    );

    return `{${serializedEntries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}
