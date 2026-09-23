// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import { describe, it } from "vite-plus/test";
import { WebSocketServer, type WebSocket } from "ws";

import { sharedCodexAppServerCommand } from "./sharedCodexAppServer.ts";

function queue<T>() {
  const entries: Array<T> = [];
  const waiting: Array<{ predicate: (value: T) => boolean; resolve: (value: T) => void }> = [];
  return {
    push(value: T) {
      const index = waiting.findIndex(({ predicate }) => predicate(value));
      if (index >= 0) waiting.splice(index, 1)[0]!.resolve(value);
      else entries.push(value);
    },
    next(predicate: (value: T) => boolean): Promise<T> {
      const index = entries.findIndex(predicate);
      if (index >= 0) return Promise.resolve(entries.splice(index, 1)[0]!);
      return new Promise((resolve) => waiting.push({ predicate, resolve }));
    },
  };
}

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
};

describe("shared Codex App Server transport", () => {
  it("selects the bridge only when a shared endpoint is configured", () => {
    NodeAssert.equal(sharedCodexAppServerCommand({}), undefined);
    const selected = sharedCodexAppServerCommand({
      T3CODE_CODEX_APP_SERVER_URL: " unix:///tmp/codex.sock ",
    });
    NodeAssert.equal(selected?.endpoint, "unix:///tmp/codex.sock");
    NodeAssert.equal(selected?.command, process.execPath);
    NodeAssert.equal(selected?.args.at(-1), "app-server");
  });

  it("reconnects the JSONL client and resumes its thread before forwarding queued requests", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-shared-codex-"));
    const socketPath = NodePath.join(directory, "app-server.sock");
    const httpServer = NodeHttp.createServer();
    const websocketServer = new WebSocketServer({ server: httpServer });
    const connections = queue<WebSocket>();
    const received = queue<{ connection: WebSocket; message: RpcMessage }>();
    websocketServer.on("connection", (connection) => {
      connections.push(connection);
      connection.on("message", (data) =>
        received.push({ connection, message: JSON.parse(data.toString()) as RpcMessage }),
      );
    });
    httpServer.listen(socketPath);
    await new Promise<void>((resolve) => httpServer.once("listening", resolve));

    const command = sharedCodexAppServerCommand({
      T3CODE_CODEX_APP_SERVER_URL: `unix://${socketPath}`,
    })!;
    const child = NodeChildProcess.spawn(command.command, command.args, {
      env: {
        ...process.env,
        CODEX_APP_SERVER_URL: command.endpoint,
        CODEX_APP_SERVER_RETRY_DELAYS_MS: "20",
        CODEX_APP_SERVER_RETRY_MAX_ATTEMPTS: "5",
      },
    });
    const output = queue<RpcMessage>();
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) =>
      output.push(JSON.parse(line) as RpcMessage),
    );
    const write = (message: RpcMessage) => child.stdin.write(`${JSON.stringify(message)}\n`);
    try {
      write({ id: 1, method: "initialize", params: {} });
      const first = await connections.next(() => true);
      await received.next(
        ({ connection, message }) => connection === first && message.method === "initialize",
      );
      first.send(JSON.stringify({ id: 1, result: { userAgent: "codex/test" } }));
      NodeAssert.deepEqual((await output.next((message) => message.id === 1)).result, {
        userAgent: "codex/test",
      });

      write({ id: 2, method: "thread/start", params: { cwd: directory } });
      await received.next(
        ({ connection, message }) => connection === first && message.method === "thread/start",
      );
      first.send(JSON.stringify({ id: 2, result: { thread: { id: "existing-thread" } } }));
      await output.next((message) => message.id === 2);

      first.close();
      write({ id: 3, method: "thread/read", params: { threadId: "existing-thread" } });
      const second = await connections.next((connection) => connection !== first);
      await received.next(
        ({ connection, message }) => connection === second && message.method === "initialize",
      );
      second.send(JSON.stringify({ id: 1, result: { userAgent: "codex/test" } }));
      const resume = await received.next(
        ({ connection, message }) => connection === second && message.method === "thread/resume",
      );
      NodeAssert.equal(resume.message.params?.threadId, "existing-thread");
      second.send(
        JSON.stringify({ id: resume.message.id, result: { thread: { id: "existing-thread" } } }),
      );
      await received.next(
        ({ connection, message }) => connection === second && message.method === "thread/read",
      );
      second.send(JSON.stringify({ id: 3, result: { thread: { id: "existing-thread" } } }));
      NodeAssert.deepEqual((await output.next((message) => message.id === 3)).result, {
        thread: { id: "existing-thread" },
      });
    } finally {
      child.kill("SIGTERM");
      child.stdin.end();
      await new Promise<void>((resolve) => child.once("exit", resolve));
      for (const connection of websocketServer.clients) connection.terminate();
      websocketServer.close();
      httpServer.close();
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
});
