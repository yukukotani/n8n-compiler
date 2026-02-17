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
      `export default workflow({\n  name: "cli-compile",\n  triggers: [n.manualTrigger()],\n  execute() {\n    n.set({ value: "ok" });\n  },\n});\n`,
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
    await Bun.write(entry, `export default workflow({ name: "broken", triggers: [n.manualTrigger()], execute() {`);

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
      `export default workflow({\n  name: "invalid",\n  triggers: [],\n  execute() {\n    n.noOp();\n  },\n});\n`,
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
      `export default workflow({\n  name: "cli-deploy",\n  triggers: [n.manualTrigger()],\n  execute() {\n    n.set({ value: "ok" });\n  },\n});\n`,
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

test("import は workflow id を受け取り DSL コードを出力する", async () => {
  const workspace = createTempDir("n8n-cli-import-");
  const apiKey = "cli-import-key";

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/v1/workflows/42" && req.method === "GET") {
        return Response.json({
          id: "42",
          name: "imported-workflow",
          active: false,
          nodes: [
            { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
            { name: "set_2", type: "n8n-nodes-base.set", typeVersion: 1, parameters: { value: "ok" }, position: [200, 0] },
          ],
          connections: {
            manualTrigger_1: { main: [[{ node: "set_2", type: "main", index: 0 }]] },
          },
          settings: { timezone: "Asia/Tokyo" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  try {
    const output = join(workspace, "workflow.ts");
    const result = await runCliAsync(["import", "42", "--out", output, "--json"], {
      env: {
        N8N_BASE_URL: server.url.toString(),
        N8N_API_KEY: apiKey,
      },
    });
    const payload = JSON.parse(toText(result.stdout));

    expect(result.exitCode).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      command: "import",
    });

    const generated = await Bun.file(output).text();
    expect(generated).toContain("imported-workflow");
    expect(generated).toContain("n.manualTrigger()");
    expect(generated).toContain("n.set(");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("import は URL から workflow id と base-url を抽出して実行する", async () => {
  const workspace = createTempDir("n8n-cli-import-url-");
  const apiKey = "cli-import-url-key";

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/v1/workflows/99" && req.method === "GET") {
        return Response.json({
          id: "99",
          name: "url-imported",
          active: false,
          nodes: [
            { name: "manualTrigger_1", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, parameters: {}, position: [0, 0] },
            { name: "noOp_2", type: "n8n-nodes-base.noOp", typeVersion: 1, parameters: {}, position: [200, 0] },
          ],
          connections: {
            manualTrigger_1: { main: [[{ node: "noOp_2", type: "main", index: 0 }]] },
          },
          settings: {},
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  try {
    const output = join(workspace, "url-workflow.ts");
    const workflowUrl = `${server.url}workflow/99`;
    // Use --base-url to override any .env N8N_BASE_URL that Bun auto-loads in child process
    const result = await runCliAsync(["import", workflowUrl, "--out", output, "--base-url", server.url.toString()], {
      env: {
        N8N_API_KEY: apiKey,
      },
    });

    expect(result.exitCode).toBe(0);

    const generated = await Bun.file(output).text();
    expect(generated).toContain("url-imported");
    expect(generated).toContain("n.manualTrigger()");
    expect(generated).toContain("n.noOp()");
  } finally {
    server.stop(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("import は API エラー時に終了コード 3 を返す", async () => {
  const workspace = createTempDir("n8n-cli-import-fail-");
  const apiKey = "cli-import-fail-key";

  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ message: "not found" }, { status: 404 });
    },
  });

  try {
    const output = join(workspace, "workflow.ts");
    const result = await runCliAsync(["import", "999", "--out", output], {
      env: {
        N8N_BASE_URL: server.url.toString(),
        N8N_API_KEY: apiKey,
      },
    });

    expect(result.exitCode).toBe(3);
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
      `export default workflow({\n  name: "cli-deploy-fail",\n  triggers: [n.manualTrigger()],\n  execute() {\n    n.noOp();\n  },\n});\n`,
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
