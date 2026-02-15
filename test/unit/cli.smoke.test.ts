import { expect, test } from "bun:test";
import { runCli } from "../helpers/cli";

test("CLI は --help で起動成功する", () => {
  const result = runCli(["--help"]);

  expect(result.exitCode).toBe(0);
});

test("CLI は不正な引数でエラー終了する", () => {
  const result = runCli(["invalid"]);

  expect(result.exitCode).toBe(1);
});
