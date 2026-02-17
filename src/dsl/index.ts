import type { WorkflowDefinition } from "./types";

export { n } from "./nodes";
export { DateTime, $ } from "./globals";
export type * from "./types";

export function workflow<TDefinition extends WorkflowDefinition>(
  definition: TDefinition,
): TDefinition {
  return definition;
}

export const TRIGGER_NODE_KINDS: ReadonlySet<string> = new Set([
  "manualTrigger",
  "scheduleTrigger",
  "webhookTrigger",
  "googleCalendarTrigger",
]);
