import { expect } from "bun:test";
import { readSnapshot } from "./fixtures";

type JsonLike = null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike };

export function expectToMatchSnapshot(value: unknown, snapshotPath: string): void {
  expect(stableStringify(value)).toBe(readSnapshot(snapshotPath));
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(toStableValue(value) ?? null, null, 2)}\n`;
}

function toStableValue(value: unknown): JsonLike | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return null;
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => {
      const stableEntry = toStableValue(entry);
      return stableEntry === undefined ? null : stableEntry;
    });
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const result: { [key: string]: JsonLike } = {};
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => {
    if (left < right) {
      return -1;
    }

    if (left > right) {
      return 1;
    }

    return 0;
  });

  for (const [key, entryValue] of entries) {
    const stableValue = toStableValue(entryValue);
    if (stableValue !== undefined) {
      result[key] = stableValue;
    }
  }

  return result;
}
