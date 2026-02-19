/**
 * n8n Code node runtime globals.
 *
 * These variables are available at runtime inside n8n Code node execution.
 * Declared globally so that `jsCode: () => { ... }` function bodies can
 * reference them without TypeScript errors.
 */

/* eslint-disable no-var */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $input: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $json: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $item: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $items: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var items: any[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $execution: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $prevNode: any;
declare var $runIndex: number;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $workflow: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $now: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $today: any;
declare var $env: Record<string, string>;
declare var $itemIndex: number;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare var $jmespath: any;
