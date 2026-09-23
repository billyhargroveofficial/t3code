import { describe, expect, it } from "@effect/vitest";

import {
  autheliaProxyConfigFromEnv,
  verifyAutheliaProxyUser,
  type AutheliaProxyConfig,
} from "./autheliaProxy.ts";

const config: AutheliaProxyConfig = {
  verifyUrl: "http://127.0.0.1:9091/sso/api/authz/forward-auth",
  publicHost: "billyhargrove.ru",
  cookieName: "billynotes_session",
  allowedUsers: new Set(["billy", "nikolay"]),
};

const headers = {
  host: "billyhargrove.ru",
  "x-forwarded-proto": "https",
  "remote-user": "billy",
  cookie: "t3_session=private; billynotes_session=valid-opaque-value; other=value",
};

describe("Authelia browser SSO", () => {
  it("requires a complete loopback-only configuration", () => {
    expect(autheliaProxyConfigFromEnv({})).toBeNull();
    expect(
      autheliaProxyConfigFromEnv({
        T3CODE_AUTHELIA_VERIFY_URL: "https://untrusted.example/auth",
        T3CODE_AUTHELIA_PUBLIC_HOST: "billyhargrove.ru",
        T3CODE_AUTHELIA_COOKIE_NAME: "billynotes_session",
        T3CODE_AUTHELIA_USERS: "billy,nikolay",
      }),
    ).toBeNull();
    expect(
      autheliaProxyConfigFromEnv({
        T3CODE_AUTHELIA_VERIFY_URL: config.verifyUrl,
        T3CODE_AUTHELIA_PUBLIC_HOST: config.publicHost,
        T3CODE_AUTHELIA_COOKIE_NAME: config.cookieName,
        T3CODE_AUTHELIA_USERS: "billy,nikolay",
      })?.allowedUsers,
    ).toEqual(new Set(["billy", "nikolay"]));
  });

  it("rejects forged proxy identity without an Authelia cookie", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response(null, { status: 200, headers: { "remote-user": "billy" } });
    };
    expect(
      await verifyAutheliaProxyUser({ ...headers, cookie: "t3_session=private" }, config, fetcher),
    ).toBeNull();
    expect(
      await verifyAutheliaProxyUser({ ...headers, host: "127.0.0.1:8214" }, config, fetcher),
    ).toBeNull();
    expect(
      await verifyAutheliaProxyUser({ ...headers, "remote-user": "outsider" }, config, fetcher),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  it("issues identity only when Authelia validates the matching account", async () => {
    const fetcher: typeof fetch = async (url, init) => {
      expect(url).toBe(config.verifyUrl);
      const forwarded = new Headers(init?.headers);
      expect(forwarded.get("cookie")).toBe("billynotes_session=valid-opaque-value");
      expect(forwarded.get("x-forwarded-host")).toBe(config.publicHost);
      return new Response(null, { status: 200, headers: { "remote-user": "billy" } });
    };
    expect(await verifyAutheliaProxyUser(headers, config, fetcher)).toBe("billy");
    expect(
      await verifyAutheliaProxyUser({ ...headers, "remote-user": "nikolay" }, config, fetcher),
    ).toBeNull();
    expect(
      await verifyAutheliaProxyUser(
        { ...headers, "remote-user": "nikolay" },
        config,
        async () => new Response(null, { status: 200, headers: { "remote-user": "nikolay" } }),
      ),
    ).toBe("nikolay");
  });

  it("fails closed when Authelia rejects or is unavailable", async () => {
    expect(
      await verifyAutheliaProxyUser(
        headers,
        config,
        async () => new Response(null, { status: 302 }),
      ),
    ).toBeNull();
    expect(
      await verifyAutheliaProxyUser(headers, config, async () => {
        throw new Error("unavailable");
      }),
    ).toBeNull();
  });
});
