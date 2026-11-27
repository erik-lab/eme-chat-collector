/**
 * Which build is running.
 *
 * Replaced at build time by esbuild's `define`. Under the test runner the
 * identifier does not exist at all, which `typeof` handles without throwing —
 * so this reads "dev" in tests and a git revision in a real build.
 */
declare const __BUILD_ID__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
