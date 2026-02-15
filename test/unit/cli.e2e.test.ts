import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, runCliAsync } from "../helpers/cli";

function toText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("compile は entry と --out を受け取り終了コード 0 で JSON を出力する", async () => {
  const workspace = createTempDir("n8n-cli-compile-");

  try {
    const entry = join(workspace, "workflow.ts");
    const output = join(workspace, "workflow.json");
    await Bun.write(
      entry,
      `export default workflow({\n  name: "cli-compile",\n  execute() {\n    n.manualTrigger();\n    n.set({ value: "ok" });\n  },\n});\n`,
    );

    const result = runCli(["compile", entry, "--out", output]);

    expect(result.exitCode).toBe(0);
    expect(await Bun.file(output).json()).toMatchObject({
      name: "cli-compile",
      nodes: expect.any(Array),
      connections: expect.any(Object),
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("compile は失敗時に終了コード 1 を返し --json で diagnostics を返す", async () => {
  const workspace = createTempDir("n8n-cli-compile-fail-");

  try {
    const entry = join(workspace, "invalid.ts");
    const output = join(workspace, "workflow.json");
    await Bun.write(entry, `export default workflow({ name: "broken", execute() {`);

    const result = runCli(["compile", entry, "--out", output, "--json"]);
    const payload = JSON.parse(toText(result.stdout));

    expect(result.exitCode).toBe(1);
    expect(payload).toMatchObject({
      ok: false,
      command: "compile",
      exitCode: 1,
      diagnostics: [expect.objectContaining({ code: "E_PARSE" })],
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("validate は構造不正を終了コード 1 として返す", async () => {
  const workspace = createTempDir("n8n-cli-validate-");

  try {
    const entry = join(workspace, "invalid-workflow.ts");
    await Bun.write(
      entry,
      `export default workflow({\n  name: "invalid",\n  execute() {\n    n.noOp();\n  },\n});\n`,
    );

    const result = runCli(["validate", entry]);

    expect(result.exitCode).toBe(1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("deploy は env fallback で実行でき --json で成功結果を返す", async () => {
  const workspace = createTempDir("n8n-cli-deploy-");
  const apiKey = "cli-test-key";
  let receivedApiKey = "";
  let createCalls = 0;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      receivedApiKey = req.headers.get("x-n8n-api-key") ?? "";

      if (url.pathname === "/api/v1/workflows" && req.method === "GET") {
        return Response.json({ data: [] });
      }

      if (url.pathname === "/api/v1/workflows" && req.method === "POST") {
        createCalls += 1;
        return Response.json({
          id: "wf-created",
          name: "cli-deploy",
          nodes: [],
          connections: {},
          settings: {},
        });
      }

      if (url.pathname === "/api/v1/workflows/wf-created/activate" && req.method === "POST") {
        return new Response(null, { status: 204 });
      }

      return new Response("not found", { status: 404 });
    },
  });

  try {
    const entry = join(workspace, "workflow.ts");
    await Bun.write(
      entry,
      `export default workflow({\n  name: "cli-deploy",\n  execute() {\n    n.manualTrigger();\n    n.set({ value: "ok" });\n  },\n});\n`,
    );

    const result = await runCliAsync(["deploy", entry, "--mode", "upsert", "--activate", "--json"], {
      env: {
        N8N_BASE_URL: server.url.toString(),
        N8N_API_KEY: apiKey,
      },
    });
    const payload = JSON.parse(toText(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(receivedApiKey).toBe(apiKey);
    expect(createCalls).toBe(1);
    expect(payload).toMatchObject({
      ok: true,
      command: "deploy",
      result: {
        operation: "create",
        activated: true,
      },
    });
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("deploy は API エラーを終了コード 2 で返し秘密情報を出力しない", async () => {
  const workspace = createTempDir("n8n-cli-deploy-fail-");
  const apiKey = "super-secret-cli-key";

  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ message: `invalid key ${apiKey}` }, { status: 401 });
    },
  });

  try {
    const entry = join(workspace, "workflow.ts");
    await Bun.write(
      entry,
      `export default workflow({\n  name: "cli-deploy-fail",\n  execute() {\n    n.manualTrigger();\n  },\n});\n`,
    );

    const result = await runCliAsync(["deploy", entry], {
      env: {
        N8N_BASE_URL: server.url.toString(),
        N8N_API_KEY: apiKey,
      },
    });
    const stdout = toText(result.stdout);
    const stderr = toText(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(stdout).not.toContain(apiKey);
    expect(stderr).not.toContain(apiKey);
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
