import { expect, test } from "bun:test";
import type { N8nWorkflow, N8nWorkflowDraftPayload, N8nWorkflowPayload } from "../../src/n8n/client";
import { deployWorkflow } from "../../src/n8n/deploy";

type ClientLike = {
  listWorkflows(input?: { name?: string }): Promise<N8nWorkflow[]>;
  createWorkflow(payload: N8nWorkflowPayload): Promise<N8nWorkflow>;
  updateWorkflow(id: string, payload: N8nWorkflowPayload): Promise<N8nWorkflow>;
  activateWorkflow(id: string): Promise<void>;
};

function createClientMock(overrides?: {
  listWorkflows?: N8nWorkflow[];
  createResult?: N8nWorkflow;
  updateResult?: N8nWorkflow;
}) {
  const calls = {
    listWorkflows: [] as Array<{ name?: string }>,
    createWorkflow: [] as N8nWorkflowPayload[],
    updateWorkflow: [] as Array<{ id: string; payload: N8nWorkflowPayload }>,
    activateWorkflow: [] as string[],
  };

  const createResult =
    overrides?.createResult ??
    ({ id: "created-1", name: "sample", nodes: [], connections: {}, settings: {} } as N8nWorkflow);
  const updateResult =
    overrides?.updateResult ??
    ({ id: "updated-1", name: "sample", nodes: [], connections: {}, settings: {} } as N8nWorkflow);

  const client: ClientLike = {
    async listWorkflows(input) {
      calls.listWorkflows.push({ name: input?.name });
      return overrides?.listWorkflows ?? [];
    },
    async createWorkflow(payload) {
      calls.createWorkflow.push(payload);
      return createResult;
    },
    async updateWorkflow(id, payload) {
      calls.updateWorkflow.push({ id, payload });
      return updateResult;
    },
    async activateWorkflow(id) {
      calls.activateWorkflow.push(id);
    },
  };

  return { client, calls, createResult, updateResult };
}

test("mode=create は createWorkflow を呼ぶ", async () => {
  const { client, calls, createResult } = createClientMock();
  const payload = { name: "sample", nodes: [], connections: {}, settings: {} };

  const result = await deployWorkflow({
    client,
    mode: "create",
    workflow: payload,
  });

  expect(calls.createWorkflow).toEqual([payload]);
  expect(calls.updateWorkflow).toHaveLength(0);
  expect(calls.listWorkflows).toHaveLength(0);
  expect(result.workflow).toEqual(createResult);
  expect(result.operation).toBe("create");
});

test("deploy 時に node id を name から自動付与する", async () => {
  const { client, calls } = createClientMock();
  const payload: N8nWorkflowDraftPayload = {
    name: "sample",
    nodes: [
      {
        name: "set_1",
        type: "n8n-nodes-base.set",
        typeVersion: 1,
        position: [120, 200],
        parameters: { value: "ok" },
      },
    ],
    connections: {},
    settings: {},
  };

  await deployWorkflow({
    client,
    mode: "create",
    workflow: payload,
  });

  expect(calls.createWorkflow[0]).toMatchObject({
    nodes: [
      expect.objectContaining({
        id: "set_1",
        name: "set_1",
      }),
    ],
  });
});

test("mode=update は id 必須で updateWorkflow を呼ぶ", async () => {
  const { client, calls, updateResult } = createClientMock();
  const payload = { name: "sample", nodes: [], connections: {}, settings: {} };

  await expect(
    deployWorkflow({
      client,
      mode: "update",
      workflow: payload,
    }),
  ).rejects.toThrow("id is required when mode=update");

  const result = await deployWorkflow({
    client,
    mode: "update",
    id: "wf-123",
    workflow: payload,
  });

  expect(calls.updateWorkflow).toEqual([{ id: "wf-123", payload }]);
  expect(calls.createWorkflow).toHaveLength(0);
  expect(calls.listWorkflows).toHaveLength(0);
  expect(result.workflow).toEqual(updateResult);
  expect(result.operation).toBe("update");
});

test("mode=upsert は name で lookup して update/create を切り替える", async () => {
  const payload = { name: "sample", nodes: [], connections: {}, settings: {} };

  const updateCase = createClientMock({
    listWorkflows: [{ id: "wf-existing", name: "sample", nodes: [], connections: {}, settings: {} }],
  });
  const updateResult = await deployWorkflow({
    client: updateCase.client,
    mode: "upsert",
    workflow: payload,
  });

  expect(updateCase.calls.listWorkflows).toEqual([{ name: "sample" }]);
  expect(updateCase.calls.updateWorkflow).toEqual([{ id: "wf-existing", payload }]);
  expect(updateCase.calls.createWorkflow).toHaveLength(0);
  expect(updateResult.operation).toBe("update");

  const createCase = createClientMock({ listWorkflows: [] });
  const createResult = await deployWorkflow({
    client: createCase.client,
    mode: "upsert",
    workflow: payload,
  });

  expect(createCase.calls.listWorkflows).toEqual([{ name: "sample" }]);
  expect(createCase.calls.updateWorkflow).toHaveLength(0);
  expect(createCase.calls.createWorkflow).toEqual([payload]);
  expect(createResult.operation).toBe("create");
});

test("activate=true は deploy 成功後に activate を呼ぶ", async () => {
  const { client, calls } = createClientMock({
    createResult: { id: "wf-created", name: "sample", nodes: [], connections: {}, settings: {} },
  });
  const payload = { name: "sample", nodes: [], connections: {}, settings: {} };

  const result = await deployWorkflow({
    client,
    mode: "create",
    activate: true,
    workflow: payload,
  });

  expect(calls.activateWorkflow).toEqual(["wf-created"]);
  expect(result.activated).toBe(true);
});
