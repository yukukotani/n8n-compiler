import { runCli } from "./cli/main";

const exitCode = await runCli(Bun.argv.slice(2));
process.exit(exitCode);
