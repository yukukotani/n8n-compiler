import { compile, createErrorDiagnostic, formatDiagnostic, type Diagnostic } from "../compiler";
import { deployWorkflow, type DeployMode } from "../n8n/deploy";
import { createN8nClient, N8nClientError } from "../n8n/client";

type CommandName = "compile" | "validate" | "deploy";

type ParsedArgs = {
  positionals: string[];
  options: Record<string, string | boolean>;
  errors: string[];
};

type CliResult = {
  command: CommandName;
  exitCode: number;
  message?: string;
  diagnostics?: Diagnostic[];
  payload?: Record<string, unknown>;
};

const EXIT_SUCCESS = 0;
const EXIT_COMPILE_OR_VALIDATE_ERROR = 1;
const EXIT_DEPLOY_ERROR = 2;

const USAGE = `Usage:
  bun run src/cli.ts <command> [options]

Commands:
  compile <entry.ts> --out <file>
  validate <entry.ts>
  deploy <entry.ts> [--mode create|update|upsert] [--id <id>] [--activate]

Global options:
  --json
  --base-url <url>   (or N8N_BASE_URL)
  --api-key <key>    (or N8N_API_KEY)`;

const SUPPORTED_COMMANDS = new Set<CommandName>(["compile", "validate", "deploy"]);
const DEPLOY_MODES = new Set<DeployMode>(["create", "update", "upsert"]);

export async function runCli(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return EXIT_SUCCESS;
  }

  const commandToken = args[0];
  if (!commandToken || !SUPPORTED_COMMANDS.has(commandToken as CommandName)) {
    console.error(`Unknown command: ${commandToken ?? ""}`);
    console.error(USAGE);
    return EXIT_COMPILE_OR_VALIDATE_ERROR;
  }

  const command = commandToken as CommandName;
  const parsed = parseArgs(args.slice(1));
  const json = hasFlag(parsed.options, "json");

  if (parsed.errors.length > 0) {
    return emitResult(
      {
        command,
        exitCode: command === "deploy" ? EXIT_DEPLOY_ERROR : EXIT_COMPILE_OR_VALIDATE_ERROR,
        message: parsed.errors.join("\n"),
      },
      json,
    );
  }

  const result =
    command === "compile"
      ? await runCompileCommand(parsed)
      : command === "validate"
        ? await runValidateCommand(parsed)
        : await runDeployCommand(parsed);

  return emitResult(result, json);
}

async function runCompileCommand(parsed: ParsedArgs): Promise<CliResult> {
  const entry = parsed.positionals[0];
  const outFile = getStringOption(parsed.options, "out");

  if (!entry || !outFile) {
    return {
      command: "compile",
      exitCode: EXIT_COMPILE_OR_VALIDATE_ERROR,
      message: "compile requires: compile <entry.ts> --out <file>",
    };
  }

  const sourceText = await readSource(entry, "compile");
  if (!sourceText.ok) {
    return sourceText.result;
  }

  const compileResult = compile({ file: entry, sourceText: sourceText.value });
  if (!compileResult.workflow || compileResult.diagnostics.length > 0) {
    return {
      command: "compile",
      exitCode: EXIT_COMPILE_OR_VALIDATE_ERROR,
      diagnostics: compileResult.diagnostics,
    };
  }

  await Bun.write(outFile, `${JSON.stringify(compileResult.workflow, null, 2)}\n`);

  return {
    command: "compile",
    exitCode: EXIT_SUCCESS,
    message: `Compiled ${entry} -> ${outFile}`,
    payload: { output: outFile },
  };
}

async function runValidateCommand(parsed: ParsedArgs): Promise<CliResult> {
  const entry = parsed.positionals[0];
  if (!entry) {
    return {
      command: "validate",
      exitCode: EXIT_COMPILE_OR_VALIDATE_ERROR,
      message: "validate requires: validate <entry.ts>",
    };
  }

  const sourceText = await readSource(entry, "validate");
  if (!sourceText.ok) {
    return sourceText.result;
  }

  const compileResult = compile({ file: entry, sourceText: sourceText.value });
  if (compileResult.diagnostics.length > 0) {
    return {
      command: "validate",
      exitCode: EXIT_COMPILE_OR_VALIDATE_ERROR,
      diagnostics: compileResult.diagnostics,
    };
  }

  return {
    command: "validate",
    exitCode: EXIT_SUCCESS,
    message: `Validation passed: ${entry}`,
  };
}

async function runDeployCommand(parsed: ParsedArgs): Promise<CliResult> {
  const entry = parsed.positionals[0];
  if (!entry) {
    return {
      command: "deploy",
      exitCode: EXIT_DEPLOY_ERROR,
      message: "deploy requires: deploy <entry.ts> [--mode create|update|upsert] [--id <id>] [--activate]",
    };
  }

  const sourceText = await readSource(entry, "deploy");
  if (!sourceText.ok) {
    return sourceText.result;
  }

  const compileResult = compile({ file: entry, sourceText: sourceText.value });
  if (!compileResult.workflow || compileResult.diagnostics.length > 0) {
    return {
      command: "deploy",
      exitCode: EXIT_COMPILE_OR_VALIDATE_ERROR,
      diagnostics: compileResult.diagnostics,
    };
  }

  const modeOption = getStringOption(parsed.options, "mode") ?? "upsert";
  if (!DEPLOY_MODES.has(modeOption as DeployMode)) {
    return {
      command: "deploy",
      exitCode: EXIT_DEPLOY_ERROR,
      message: `invalid --mode: ${modeOption}`,
    };
  }

  const baseUrl = getStringOption(parsed.options, "base-url") ?? Bun.env.N8N_BASE_URL;
  const apiKey = getStringOption(parsed.options, "api-key") ?? Bun.env.N8N_API_KEY;
  if (!baseUrl || !apiKey) {
    return {
      command: "deploy",
      exitCode: EXIT_DEPLOY_ERROR,
      message: "deploy requires --base-url/--api-key (or N8N_BASE_URL/N8N_API_KEY)",
    };
  }

  const client = createN8nClient({
    baseUrl,
    apiKey,
    file: entry,
  });

  try {
    const result = await deployWorkflow({
      client,
      workflow: compileResult.workflow,
      mode: modeOption as DeployMode,
      id: getStringOption(parsed.options, "id"),
      activate: hasFlag(parsed.options, "activate"),
    });

    return {
      command: "deploy",
      exitCode: EXIT_SUCCESS,
      message: `Deployed ${entry} (${result.operation}) id=${result.workflow.id ?? "unknown"}`,
      payload: {
        result: {
          operation: result.operation,
          activated: result.activated,
          workflowId: result.workflow.id ?? null,
        },
      },
    };
  } catch (error) {
    if (error instanceof N8nClientError) {
      return {
        command: "deploy",
        exitCode: EXIT_DEPLOY_ERROR,
        diagnostics: [error.diagnostic],
      };
    }

    return {
      command: "deploy",
      exitCode: EXIT_DEPLOY_ERROR,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function emitResult(result: CliResult, json: boolean): number {
  if (json) {
    if (result.exitCode === EXIT_SUCCESS) {
      console.log(
        JSON.stringify({
          ok: true,
          command: result.command,
          ...(result.payload ?? {}),
        }),
      );
      return result.exitCode;
    }

    console.log(
      JSON.stringify({
        ok: false,
        command: result.command,
        exitCode: result.exitCode,
        diagnostics: result.diagnostics,
        error: result.message,
      }),
    );
    return result.exitCode;
  }

  if (result.exitCode === EXIT_SUCCESS) {
    if (result.message) {
      console.log(result.message);
    }
    return result.exitCode;
  }

  if (result.diagnostics && result.diagnostics.length > 0) {
    for (const diagnostic of result.diagnostics) {
      console.error(formatDiagnostic(diagnostic));
    }
  } else if (result.message) {
    console.error(result.message);
  }

  return result.exitCode;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | boolean> = {};
  const errors: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    if (!key) {
      errors.push(`invalid option: ${token}`);
      continue;
    }

    if (key === "json" || key === "activate") {
      options[key] = true;
      continue;
    }

    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      errors.push(`option requires value: --${key}`);
      continue;
    }

    options[key] = next;
    index += 1;
  }

  return { positionals, options, errors };
}

function hasFlag(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true;
}

function getStringOption(options: Record<string, string | boolean>, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

async function readSource(
  entry: string,
  command: "compile" | "validate" | "deploy",
): Promise<{ ok: true; value: string } | { ok: false; result: CliResult }> {
  try {
    return {
      ok: true,
      value: await Bun.file(entry).text(),
    };
  } catch (error) {
    return {
      ok: false,
      result: {
        command,
        exitCode: EXIT_COMPILE_OR_VALIDATE_ERROR,
        diagnostics: [
          createErrorDiagnostic({
            code: "E_PARSE",
            file: entry,
            message: error instanceof Error ? error.message : String(error),
          }),
        ],
      },
    };
  }
}
