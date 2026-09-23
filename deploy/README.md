# Shared Codex App Server deployment

This fork runs T3 Code as a persistent browser client for the existing Codex
App Server on `mujik`. It does not start another `codex app-server`: the T3
server starts a small JSONL/WebSocket bridge for each Codex connection and
attaches to the Unix socket named by `T3CODE_CODEX_APP_SERVER_URL`. Provider
status probes use the same bridge. The bridge reconnects if the Unix socket is
temporarily unavailable and resumes known thread IDs before sending queued
requests. A request already in flight at the instant of a disconnect is not
replayed because its outcome might be unknown.

The browser connects to T3's persistent server, so closing or reconnecting a
browser tab does not terminate T3's running sessions. A second client
connection to the same Codex App Server lists Codex threads, creates matching
T3 projects from their working directories, and synchronizes visible user and
assistant text by stable Codex item ID. It checks active threads every two
seconds and refreshes the complete list every 30 seconds; thread notifications
prompt an earlier refresh. T3 keeps each Codex thread ID as a resume cursor,
so a turn sent from T3 continues that Codex conversation. The initial view of
each thread includes its latest 200 text messages; tool output, images and
older text remain in Codex's own history. The shared daemon and its existing
Desktop/CLI clients remain running separately. If a browser socket drops, the
sidebar can load from the authenticated HTTP snapshot while it reconnects.

## Local service

From `/home/billy/t3code-shared`:

```sh
pnpm install --frozen-lockfile
pnpm --filter @t3tools/web build
pnpm --filter t3 build:bundle
install -m 644 deploy/t3code-shared.service ~/.config/systemd/user/t3code-shared.service
systemctl --user daemon-reload
systemctl --user enable --now t3code-shared.service
curl -I http://127.0.0.1:8214/
```

The service listens only on `127.0.0.1:8214`; Caddy publishes it at the root
of `https://billyhargrove.ru/`. The root Caddy route uses Authelia, which
allows only `billy` and `nikolay` for T3 Code. `/codex` redirects to `/`.
Existing more-specific routes on the domain remain ahead of the T3 fallback.
The service unit enables Authelia SSO. On the first `/api/auth/session` request,
T3 verifies the forwarded username and the Authelia session cookie with the
local forward-auth endpoint, then gives that browser its own T3 cookie. Both
users see the **same T3 environment, projects, and threads**. Opening the
domain after Authelia login is sufficient; there is no pairing step for these
two accounts. Forged `Remote-User` headers without a valid Authelia cookie are
rejected, including direct requests to the loopback port.

`apply-caddy.py check` verifies the exact reviewed `/etc/caddy/Caddyfile` and
validates the proposed replacement. Its `apply` and `rollback` actions require
sudo. `apply` saves `/etc/caddy/Caddyfile.pre-t3code`, writes atomically and
reloads Caddy; if reload fails it restores the previous file. The expected
change can be printed with `apply-caddy.py diff`.
The same command upgrades the exact first T3 configuration if `/codex` still
returns an empty `200`; that version had a redirect matcher typo.

```sh
python3 deploy/apply-caddy.py check
python3 deploy/apply-caddy.py diff
sudo /usr/bin/python3 /home/billy/t3code-shared/deploy/apply-caddy.py apply
```

Manual T3 pairing remains available for deployments without Authelia SSO,
but is unnecessary on `billyhargrove.ru`. If the SSO path is temporarily
unavailable, issue a short-lived link as `billy` from this checkout. Keep the
printed link private; it contains a bearer credential.

```sh
node apps/server/dist/bin.mjs auth pairing create --base-dir /home/billy/.local/share/t3code-shared --base-url https://billyhargrove.ru --ttl 1h --label billy
node apps/server/dist/bin.mjs auth pairing create --base-dir /home/billy/.local/share/t3code-shared --base-url https://billyhargrove.ru --ttl 1h --label nikolay
```

The Authelia passwords are the existing passwords for those accounts. There
is no new shared T3 password. Revoke unused pairing links with `auth pairing
list` and `auth pairing revoke <id>` using the same `--base-dir`.

## Recovery

```sh
systemctl --user status t3code-shared.service
journalctl --user -u t3code-shared.service -b --no-pager
sudo /usr/bin/python3 /home/billy/t3code-shared/deploy/apply-caddy.py rollback
```

Do not print startup pairing URLs from the journal in public logs or issue
reports. Do not expose the Codex Unix socket, CDP port, or T3's loopback port
directly on the internet.
