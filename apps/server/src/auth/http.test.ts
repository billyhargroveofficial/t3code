import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("creates a browser session after verified Authelia SSO without pairing", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      (environment) =>
        Effect.tryPromise(async () => {
          const previousFetch = globalThis.fetch;
          const envNames = [
            "T3CODE_AUTHELIA_VERIFY_URL",
            "T3CODE_AUTHELIA_PUBLIC_HOST",
            "T3CODE_AUTHELIA_COOKIE_NAME",
            "T3CODE_AUTHELIA_USERS",
          ] as const;
          const previousEnv = envNames.map((name) => process.env[name]);
          try {
            process.env.T3CODE_AUTHELIA_VERIFY_URL =
              "http://127.0.0.1:9091/sso/api/authz/forward-auth";
            process.env.T3CODE_AUTHELIA_PUBLIC_HOST = "billyhargrove.ru";
            process.env.T3CODE_AUTHELIA_COOKIE_NAME = "billynotes_session";
            process.env.T3CODE_AUTHELIA_USERS = "billy,nikolay";
            globalThis.fetch = vi.fn(
              async () => new Response(null, { status: 200, headers: { "remote-user": "billy" } }),
            );

            const requestHeaders = {
              host: "billyhargrove.ru",
              "x-forwarded-proto": "https",
              "remote-user": "billy",
              cookie: "billynotes_session=valid",
            };
            const first = await environment.handler(
              new Request("http://127.0.0.1/api/auth/session", { headers: requestHeaders }),
              requestContext,
            );
            expect(first.status).toBe(200);
            expect(await first.json()).toMatchObject({ authenticated: true });
            const cookie = first.headers
              .getSetCookie()
              .find((entry) => entry.startsWith("t3_session_"));
            expect(cookie).toContain("HttpOnly");

            const second = await environment.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { cookie: cookie!.split(";", 1)[0]! },
              }),
              requestContext,
            );
            expect(await second.json()).toMatchObject({ authenticated: true });

            const forged = await environment.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { ...requestHeaders, cookie: "" },
              }),
              requestContext,
            );
            expect(await forged.json()).toMatchObject({ authenticated: false });
          } finally {
            globalThis.fetch = previousFetch;
            envNames.forEach((name, index) => {
              const previous = previousEnv[index];
              if (previous === undefined) delete process.env[name];
              else process.env[name] = previous;
            });
          }
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
