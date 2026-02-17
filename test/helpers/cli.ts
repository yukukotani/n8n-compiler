type RunCliOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
};

function buildEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy process.env first
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  // Apply overrides: undefined means "remove this key"
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === "string") {
      env[key] = value;
    } else {
      delete env[key];
    }
  }

  return env;
}

export function runCli(args: string[], options: RunCliOptions = {}) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function runCliAsync(args: string[], options: RunCliOptions = {}) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "src/cli.ts", ...args],
    cwd: options.cwd,
    env: buildEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutBuffer, stderrBuffer, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).arrayBuffer(),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout: new Uint8Array(stdoutBuffer),
    stderr: new Uint8Array(stderrBuffer),
  };
}
