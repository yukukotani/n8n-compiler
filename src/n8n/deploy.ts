import type { N8nWorkflow, N8nWorkflowPayload } from "./client";

export type DeployMode = "create" | "update" | "upsert";

export type DeployClient = {
  listWorkflows(input?: { name?: string }): Promise<N8nWorkflow[]>;
  createWorkflow(payload: N8nWorkflowPayload): Promise<N8nWorkflow>;
  updateWorkflow(id: string, payload: N8nWorkflowPayload): Promise<N8nWorkflow>;
  activateWorkflow(id: string): Promise<void>;
};

export type DeployInput = {
  client: DeployClient;
  workflow: N8nWorkflowPayload;
  mode?: DeployMode;
  id?: string;
  activate?: boolean;
};

export type DeployResult = {
  workflow: N8nWorkflow;
  operation: "create" | "update";
  activated: boolean;
};

export async function deployWorkflow(input: DeployInput): Promise<DeployResult> {
  const mode = input.mode ?? "upsert";
  const operation = createOperation(mode);
  const deployed = await operation(input);

  const activated = Boolean(input.activate);
  if (activated) {
    const workflowId = deployed.workflow.id;
    if (!workflowId) {
      throw new Error("deployed workflow id is required when activate=true");
    }

    await input.client.activateWorkflow(workflowId);
  }

  return {
    workflow: deployed.workflow,
    operation: deployed.operation,
    activated,
  };
}

type DeployOperation = (input: DeployInput) => Promise<{ workflow: N8nWorkflow; operation: "create" | "update" }>;

const deployOperations: Record<DeployMode, DeployOperation> = {
  create: async (input) => ({
    workflow: await input.client.createWorkflow(input.workflow),
    operation: "create",
  }),
  update: async (input) => {
    const workflowId = requireWorkflowId(input.id, "update");
    return {
      workflow: await input.client.updateWorkflow(workflowId, input.workflow),
      operation: "update",
    };
  },
  upsert: async (input) => {
    const matched = await findWorkflowByName(input.client, input.workflow.name);
    if (matched?.id) {
      return {
        workflow: await input.client.updateWorkflow(matched.id, input.workflow),
        operation: "update",
      };
    }

    return {
      workflow: await input.client.createWorkflow(input.workflow),
      operation: "create",
    };
  },
};

function createOperation(mode: DeployMode): DeployOperation {
  return deployOperations[mode];
}

function requireWorkflowId(id: string | undefined, mode: DeployMode): string {
  if (!id) {
    throw new Error(`id is required when mode=${mode}`);
  }

  return id;
}

async function findWorkflowByName(client: DeployClient, name: string): Promise<N8nWorkflow | undefined> {
  const workflows = await client.listWorkflows({ name });
  return workflows.find((workflow) => workflow.name === name);
}
