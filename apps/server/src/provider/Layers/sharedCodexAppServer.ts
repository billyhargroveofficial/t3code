import * as NodeURL from "node:url";

import type { ResolvedSpawnCommand } from "@t3tools/shared/shell";

/** A JSONL bridge is the child process; the Codex App Server remains shared. */
export function sharedCodexAppServerCommand(
  environment: NodeJS.ProcessEnv = process.env,
): (ResolvedSpawnCommand & { readonly endpoint: string }) | undefined {
  const endpoint = environment.T3CODE_CODEX_APP_SERVER_URL?.trim();
  if (!endpoint) return undefined;

  return {
    command: process.execPath,
    args: [
      NodeURL.fileURLToPath(new URL("./sharedCodexAppServerProxy.mjs", import.meta.url)),
      "app-server",
    ],
    shell: false,
    endpoint,
  };
}
