/**
 * Optional browser SSO for installations already protected by Authelia.
 * The proxy identity header is never sufficient by itself: verify the
 * Authelia cookie with the local forward-auth endpoint before issuing a T3
 * session. This also rejects forged headers sent directly to the loopback port.
 */
export interface AutheliaProxyConfig {
  readonly verifyUrl: string;
  readonly publicHost: string;
  readonly cookieName: string;
  readonly allowedUsers: ReadonlySet<string>;
}

type RequestHeaders = Readonly<Record<string, string | undefined>>;

export function autheliaProxyConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AutheliaProxyConfig | null {
  const verifyUrl = env.T3CODE_AUTHELIA_VERIFY_URL;
  const publicHost = env.T3CODE_AUTHELIA_PUBLIC_HOST;
  const cookieName = env.T3CODE_AUTHELIA_COOKIE_NAME;
  const allowedUsers = new Set(
    env.T3CODE_AUTHELIA_USERS?.split(",")
      .map((user) => user.trim())
      .filter(Boolean) ?? [],
  );
  if (!verifyUrl || !publicHost || !cookieName || allowedUsers.size === 0) {
    return null;
  }
  try {
    const url = new URL(verifyUrl);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
      !/^[a-z0-9.-]+$/i.test(publicHost) ||
      !/^[a-zA-Z0-9_-]+$/.test(cookieName)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { verifyUrl, publicHost, cookieName, allowedUsers };
}

function onlyCookie(headers: RequestHeaders, name: string): string | null {
  const matches = (headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) {
    return null;
  }
  const value = matches[0]!.slice(name.length + 1);
  return value && !/[\s;\r\n]/.test(value) ? `${name}=${value}` : null;
}

export async function verifyAutheliaProxyUser(
  headers: RequestHeaders,
  config: AutheliaProxyConfig,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const user = headers["remote-user"]?.trim();
  if (
    !user ||
    !config.allowedUsers.has(user) ||
    headers.host !== config.publicHost ||
    headers["x-forwarded-proto"] !== "https"
  ) {
    return null;
  }
  const cookie = onlyCookie(headers, config.cookieName);
  if (!cookie) {
    return null;
  }

  try {
    const response = await fetcher(config.verifyUrl, {
      method: "GET",
      headers: {
        host: config.publicHost,
        cookie,
        "x-forwarded-host": config.publicHost,
        "x-forwarded-proto": "https",
        "x-forwarded-method": "GET",
        "x-forwarded-uri": "/",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok && response.headers.get("remote-user") === user ? user : null;
  } catch {
    return null;
  }
}
