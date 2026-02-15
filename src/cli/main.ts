const SUPPORTED_COMMANDS = new Set(["compile", "validate", "deploy"]);

const USAGE = `Usage:
  bun run src/cli.ts <command> [options]

Commands:
  compile
  validate
  deploy`;

export function runCli(args: string[]): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  const command = args[0]!;
  if (!SUPPORTED_COMMANDS.has(command)) {
    console.error(`Unknown command: ${command}`);
    console.error(USAGE);
    return 1;
  }

  console.log(`Command '${command}' is not implemented yet.`);
  return 0;
}
