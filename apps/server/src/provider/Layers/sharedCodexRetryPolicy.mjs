// The shared App Server can restart independently of the T3 frontend.
const PREFIX = "CODEX_APP_SERVER_";
const MAX_TIMER = 2 ** 31 - 1;
const legacyNames = [
  "RECONNECT_ATTEMPTS",
  "RECONNECT_DELAY_MS",
  "RECONNECT_BACKOFF_ATTEMPTS",
  "RECONNECT_BACKOFF_INITIAL_DELAY_MS",
  "RECONNECT_BACKOFF_INCREMENT_MS",
];

export function integerSetting(env, name, fallback, minimum = 0, maximum = MAX_TIMER) {
  const raw = env[PREFIX + name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${PREFIX}${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function retryPolicy(env = process.env, warn = () => {}) {
  const legacy = legacyNames.filter((name) => env[PREFIX + name]?.trim());
  const modern = ["RETRY_DELAYS_MS", "RETRY_MAX_ATTEMPTS"].some((name) =>
    env[PREFIX + name]?.trim(),
  );
  if (legacy.length) {
    warn(
      `Deprecated reconnect settings: ${legacy.map((name) => PREFIX + name).join(", ")}. ` +
        (modern
          ? "RETRY_* settings take precedence."
          : "Use CODEX_APP_SERVER_RETRY_DELAYS_MS and CODEX_APP_SERVER_RETRY_MAX_ATTEMPTS."),
    );
  }
  if (legacy.length && !modern) {
    const quick = integerSetting(env, "RECONNECT_ATTEMPTS", 5);
    const delay = integerSetting(env, "RECONNECT_DELAY_MS", 30_000, 1);
    const backoff = integerSetting(env, "RECONNECT_BACKOFF_ATTEMPTS", 10);
    const initial = integerSetting(env, "RECONNECT_BACKOFF_INITIAL_DELAY_MS", 300_000, 1);
    const increment = integerSetting(env, "RECONNECT_BACKOFF_INCREMENT_MS", 300_000);
    if (initial + Math.max(0, backoff - 1) * increment > MAX_TIMER) {
      throw new Error("configured reconnect backoff exceeds the supported timer range");
    }
    return {
      exhausted: `after ${quick} quick and ${backoff} backoff reconnect attempts`,
      next(attempt) {
        if (attempt <= quick)
          return {
            delay: delay,
            description: `quick attempt ${attempt}/${quick}`,
          };
        if (attempt <= quick + backoff)
          return {
            delay: initial + (attempt - quick - 1) * increment,
            description: `backoff attempt ${attempt - quick}/${backoff}`,
          };
        return null;
      },
    };
  }
  const raw = env[PREFIX + "RETRY_DELAYS_MS"]?.trim() || "10000,10000,20000,30000";
  const delays = raw.split(",").map((value) => {
    if (!value.trim())
      throw new Error(
        `${PREFIX}RETRY_DELAYS_MS must be a comma-separated list of positive millisecond delays`,
      );
    return integerSetting({ [PREFIX + "RETRY_DELAYS_MS"]: value }, "RETRY_DELAYS_MS", 0, 1);
  });
  const limit = integerSetting(env, "RETRY_MAX_ATTEMPTS", 0);
  return {
    exhausted: `after ${limit} reconnect attempts`,
    next(attempt) {
      if (limit && attempt > limit) return null;
      return {
        delay: delays[Math.min(attempt - 1, delays.length - 1)],
        description: `attempt ${attempt}${limit ? `/${limit}` : ""}`,
      };
    },
  };
}
