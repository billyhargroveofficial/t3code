import * as NodeNet from "node:net";
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";

import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { WebSocket } from "ws";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";

interface CodexThreadSummary {
  readonly id: string;
  readonly cwd: string;
  readonly name: string | null;
  readonly preview: string;
  readonly model: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: { readonly type: string };
  readonly turns?: ReadonlyArray<CodexTurn>;
}

interface CodexTurn {
  readonly id: string;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly items: ReadonlyArray<{
    readonly id: string;
    readonly type: string;
    readonly text?: string;
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  }>;
}

interface CodexMessage {
  readonly messageId: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

function isoTime(seconds: number | null | undefined): string {
  return DateTime.formatIso(
    DateTime.makeUnsafe(
      typeof seconds === "number" && Number.isFinite(seconds) ? seconds * 1000 : 0,
    ),
  );
}

function visibleTitle(thread: CodexThreadSummary): string {
  return (
    thread.name?.trim() ||
    thread.preview.trim().split("\n")[0]?.trim() ||
    "Codex thread"
  ).slice(0, 100);
}

function visibleMessages(thread: CodexThreadSummary): ReadonlyArray<CodexMessage> {
  const messages: CodexMessage[] = [];
  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      const role =
        item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : null;
      if (role === null) continue;
      const text =
        role === "user"
          ? (item.content ?? [])
              .filter((part) => part.type === "text")
              .map((part) => part.text ?? "")
              .join("\n")
          : (item.text ?? "");
      if (!text.trim()) continue;
      messages.push({
        messageId: MessageId.make(`import:codex:${thread.id}:item:${item.id}`),
        role,
        text,
        createdAt: isoTime(
          role === "assistant" ? (turn.completedAt ?? turn.startedAt) : turn.startedAt,
        ),
      });
    }
  }
  return messages.slice(-200);
}

type PendingRequest = {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/** A second client connection to the existing daemon, never another app-server process. */
class SharedCodexClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private closed = false;
  private dirty = true;

  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  takeDirty(): boolean {
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }

  close(): void {
    this.closed = true;
    this.socket?.terminate();
    this.socket = null;
    this.rejectPending(new Error("Codex mirror stopped"));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      NodeTimers.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private send(method: string, params: unknown): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Codex App Server is disconnected"));
    }
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      // The transport owns a Promise timeout outside Effect's scheduler.
      // @effect-diagnostics-next-line globalTimers:off
      const timer = NodeTimers.setTimeout(() => {
        this.pending.delete(id);
        socket.terminate();
        reject(new Error(`Codex App Server ${method} timed out`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.method === "string") {
      if (message.method.startsWith("thread/")) this.dirty = true;
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    NodeTimers.clearTimeout(pending.timer);
    if (message.error) {
      const error = message.error as { message?: string };
      pending.reject(new Error(error.message || "Codex App Server request failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error("Codex mirror stopped");
    if (this.socket?.readyState === WebSocket.OPEN && !this.connecting) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socket = new WebSocket("ws://localhost/rpc", {
        createConnection: () => NodeNet.createConnection(this.socketPath),
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
      });
      this.socket = socket;
      socket.on("message", (data) => this.onMessage(data));
      socket.on("close", () => {
        if (this.socket === socket) this.socket = null;
        this.dirty = true;
        this.rejectPending(new Error("Codex App Server connection closed"));
      });
      socket.on("error", () => socket.terminate());
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("close", () => reject(new Error("Codex App Server connection failed")));
      });
      await this.send("initialize", {
        clientInfo: { name: "t3-shared-mirror", title: "T3 shared Codex mirror", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: "initialized" }));
      this.dirty = true;
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.connect();
    return this.send(method, params);
  }

  async listThreads(): Promise<ReadonlyArray<CodexThreadSummary>> {
    const threads: CodexThreadSummary[] = [];
    let cursor: string | null = null;
    do {
      const result = (await this.request("thread/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })) as {
        data?: ReadonlyArray<CodexThreadSummary>;
        nextCursor?: string | null;
      };
      if (!Array.isArray(result?.data)) throw new Error("Codex thread/list returned no data");
      threads.push(
        ...result.data.filter(
          (thread) => typeof thread.id === "string" && typeof thread.cwd === "string",
        ),
      );
      cursor = result.nextCursor || null;
    } while (cursor);
    return threads;
  }

  async readThread(id: string): Promise<CodexThreadSummary> {
    const result = (await this.request("thread/read", { threadId: id, includeTurns: true })) as {
      thread?: CodexThreadSummary;
    };
    if (!result?.thread || result.thread.id !== id)
      throw new Error("Codex thread/read returned another thread");
    return result.thread;
  }
}

/** Keep T3's event projection aligned with Codex CLI/Desktop's shared daemon. */
export const sharedCodexMirrorLayer = (awaitActivation: Effect.Effect<void>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const endpoint = NodeProcess.env.T3CODE_CODEX_APP_SERVER_URL?.trim();
      if (!endpoint?.startsWith("unix:///")) return;
      const client = new SharedCodexClient(endpoint.slice("unix://".length));
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const crypto = yield* Crypto.Crypto;
      const provider = ProviderDriverKind.make("codex");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const projects = new Map<string, ProjectId>();
      const knownUpdates = new Map<string, number>();
      let lastListAt = 0;
      let knownThreads: ReadonlyArray<CodexThreadSummary> = [];

      const ensureProject = Effect.fn("SharedCodexMirror.ensureProject")(function* (cwd: string) {
        const cached = projects.get(cwd);
        if (cached) return cached;
        const found = yield* snapshots.getActiveProjectByWorkspaceRoot(cwd);
        if (Option.isSome(found)) {
          projects.set(cwd, found.value.id);
          return found.value.id;
        }
        const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          projectId,
          title: cwd.split("/").filter(Boolean).at(-1) || cwd,
          workspaceRoot: cwd,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        projects.set(cwd, projectId);
        return projectId;
      });

      const synchronizeThread = Effect.fn("SharedCodexMirror.synchronizeThread")(function* (
        summary: CodexThreadSummary,
      ) {
        if (!summary.cwd.startsWith("/")) return;
        // T3 may still be creating its own provider binding for a new thread.
        if (summary.createdAt * 1000 > (yield* Clock.currentTimeMillis) - 8_000) return;
        const bindings = yield* directory.listBindings();
        const existingBinding = bindings.find(
          (binding) =>
            binding.provider === provider &&
            typeof binding.resumeCursor === "object" &&
            binding.resumeCursor !== null &&
            "threadId" in binding.resumeCursor &&
            binding.resumeCursor.threadId === summary.id,
        );
        const threadId = existingBinding?.threadId ?? ThreadId.make(`import:codex:${summary.id}`);
        const projectId = yield* ensureProject(summary.cwd);
        const existingShell = yield* snapshots.getThreadShellById(threadId);
        if (Option.isNone(existingShell)) {
          yield* directory.upsert(
            {
              threadId,
              provider,
              providerInstanceId,
              status: "stopped",
              runtimeMode: DEFAULT_RUNTIME_MODE,
              resumeCursor: { threadId: summary.id },
              runtimePayload: { cwd: summary.cwd },
            },
            { onConflict: "ignore" },
          );
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId,
            title: visibleTitle(summary),
            modelSelection: {
              instanceId: providerInstanceId,
              model: summary.model || DEFAULT_MODEL_BY_PROVIDER[provider] || DEFAULT_MODEL,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: isoTime(summary.createdAt),
            historyImport: true,
          });
        }

        const read = yield* Effect.tryPromise(() => client.readThread(summary.id));
        const codexMessages = visibleMessages(read);
        const detail = yield* snapshots.getThreadDetailById(threadId);
        if (Option.isNone(detail) || detail.value.session?.status === "running") return;
        const existingMessages = detail.value.messages;
        const byId = new Map(existingMessages.map((message) => [message.id, message] as const));
        const oldMessages = existingMessages.filter(
          (message) => !String(message.id).includes(":item:"),
        );
        const latestOldMessageAt = oldMessages.reduce(
          (latest, message) => (message.createdAt > latest ? message.createdAt : latest),
          "",
        );
        const newMessages = codexMessages.filter((message) => {
          const present = byId.get(message.messageId);
          if (present) return present.text !== message.text;
          if (message.createdAt < latestOldMessageAt) return false;
          // Filesystem imports and T3-originated turns predate stable Codex item
          // ids. Match their exact visible text before adding a duplicate.
          return !oldMessages.some((old) => old.role === message.role && old.text === message.text);
        });
        if (newMessages.length > 0) {
          yield* engine.dispatch({
            type: "thread.history.sync",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            observedAt: isoTime(Math.max(summary.updatedAt, summary.createdAt)),
            messages: newMessages,
          });
        }
        knownUpdates.set(summary.id, summary.updatedAt);
      });

      yield* Effect.addFinalizer(() => Effect.sync(() => client.close()));
      yield* Effect.forkScoped(
        awaitActivation.pipe(
          Effect.andThen(
            Effect.forever(
              Effect.gen(function* () {
                if (client.takeDirty() || (yield* Clock.currentTimeMillis) - lastListAt > 30_000) {
                  knownThreads = yield* Effect.tryPromise(() => client.listThreads());
                  lastListAt = yield* Clock.currentTimeMillis;
                }
                for (const summary of knownThreads) {
                  if (
                    summary.status?.type !== "active" &&
                    knownUpdates.get(summary.id) === summary.updatedAt
                  ) {
                    continue;
                  }
                  yield* synchronizeThread(summary).pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("Could not mirror a Codex thread", {
                        threadId: summary.id,
                        cause,
                      }),
                    ),
                  );
                }
              }).pipe(
                Effect.catch((cause) => Effect.logWarning("Codex mirror will retry", { cause })),
                Effect.andThen(Effect.sleep("2 seconds")),
              ),
            ),
          ),
        ),
      );
    }),
  );
