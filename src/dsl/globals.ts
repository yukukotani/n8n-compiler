/**
 * n8n expression runtime globals.
 *
 * These are compile-time stubs for n8n built-in globals available in expression context.
 * The compiler serializes usage of these into n8n expression strings (={{...}}).
 * At runtime, n8n provides the actual implementations.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DateTime: any = undefined as any;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const $: (nodeName: string) => any = undefined as any;
