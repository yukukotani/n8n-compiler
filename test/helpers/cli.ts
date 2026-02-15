export function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
}
