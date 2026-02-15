import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = join(import.meta.dir, "..");

export function readFixture(relativePath: string): string {
  return readFileSync(join(TEST_ROOT, "fixtures", relativePath), "utf8");
}

export function readSnapshot(relativePath: string): string {
  return readFileSync(join(TEST_ROOT, "snapshots", relativePath), "utf8");
}
