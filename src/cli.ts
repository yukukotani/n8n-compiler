import { runCli } from "./cli/main";

const exitCode = runCli(Bun.argv.slice(2));
process.exit(exitCode);
