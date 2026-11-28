/**
 * The adapter registry.
 *
 * Adding an engine is adding a line here and a file beside this one.
 * Gemini is deferred because `batchexecute` is
 * an RPC protocol to reimplement and then maintain against a build string
 * that changes with every Google deploy.
 */

import type { ProviderAdapter } from "../types.js";
import { chatgpt } from "./chatgpt.js";
import { claude } from "./claude.js";
import { grok } from "./grok.js";

export const PROVIDERS: ProviderAdapter[] = [chatgpt, claude, grok];

export function providerBySource(source: string): ProviderAdapter | undefined {
  return PROVIDERS.find((p) => p.source === source);
}
