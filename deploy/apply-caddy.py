#!/usr/bin/python3
"""Switch billyhargrove.ru from the retired /codex client to T3 Code."""

import argparse
import difflib
import fcntl
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile


TARGET = Path('/etc/caddy/Caddyfile')
BACKUP = Path('/etc/caddy/Caddyfile.pre-t3code')
EXPECTED_SHA256 = '89e33a955871fe4d8dd621303193b81241d7099b6c02aeb6803e97cfcb7a3bf1'
OLD_START = b'\t# BEGIN codex-web\n'
OLD_END = b'\t# END codex-web\n'
OLD_FALLBACK = b'\thandle {\n\t\trespond "Not found" 404\n\t}\n'
NEW_BLOCK = b'''\t# BEGIN t3code
\t@retired_codex path /codex /codex/*
\thandle @retired_codex {
\t\tredir / 308
\t}
\t# END t3code
'''
NEW_FALLBACK = b'''\thandle {
\t\troute {
\t\t\trequest_header -Remote-User
\t\t\trequest_header -Remote-Groups
\t\t\trequest_header -Remote-Name
\t\t\trequest_header -Remote-Email
\t\t\tforward_auth 127.0.0.1:9091 {
\t\t\t\turi /sso/api/authz/forward-auth
\t\t\t\tcopy_headers Remote-User Remote-Groups Remote-Name Remote-Email
\t\t\t}
\t\t\treverse_proxy 127.0.0.1:8214 {
\t\t\t\tstream_close_delay 5m
\t\t\t\ttransport http {
\t\t\t\t\tdial_timeout 5s
\t\t\t\t}
\t\t\t}
\t\t}
\t}
'''


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def proposed(original: bytes) -> bytes:
    if digest(original) != EXPECTED_SHA256:
        raise SystemExit('Caddyfile differs from the reviewed original; stopped.')
    if original.count(OLD_START) != 1 or original.count(OLD_END) != 1:
        raise SystemExit('Expected old codex-web block not found exactly once.')
    if original.count(OLD_FALLBACK) != 1:
        raise SystemExit('Expected root fallback not found exactly once.')
    start = original.index(OLD_START)
    end = original.index(OLD_END, start) + len(OLD_END)
    return (original[:start] + NEW_BLOCK + original[end:]).replace(
        OLD_FALLBACK, NEW_FALLBACK, 1
    )


def validate(data: bytes) -> None:
    with tempfile.TemporaryDirectory(prefix='t3code-caddy-', dir='/run' if os.geteuid() == 0 else None) as temporary:
        staged = Path(temporary) / 'Caddyfile'
        staged.write_bytes(data)
        subprocess.run(['/usr/bin/caddy', 'validate', '--config', str(staged), '--adapter', 'caddyfile'], check=True)


def atomic_write(data: bytes, expected_hash: str) -> None:
    if TARGET.is_symlink() or digest(TARGET.read_bytes()) != expected_hash:
        raise SystemExit('Caddyfile changed concurrently; stopped.')
    info = TARGET.stat()
    fd, temporary = tempfile.mkstemp(prefix='.t3code-', dir=TARGET.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            os.fchmod(output.fileno(), info.st_mode & 0o777)
            os.fchown(output.fileno(), info.st_uid, info.st_gid)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        if digest(TARGET.read_bytes()) != expected_hash:
            raise SystemExit('Caddyfile changed concurrently; stopped.')
        os.replace(temporary, TARGET)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'diff', 'apply', 'rollback'])
    action = parser.parse_args().action
    if TARGET.is_symlink():
        raise SystemExit('Refusing a symlink Caddyfile.')
    if action == 'check':
        next_config = proposed(TARGET.read_bytes())
        validate(next_config)
        print('Reviewed T3 Code Caddy configuration is valid.')
        return
    if action == 'diff':
        original = TARGET.read_bytes()
        next_config = proposed(original)
        print(''.join(difflib.unified_diff(
            original.decode().splitlines(keepends=True),
            next_config.decode().splitlines(keepends=True),
            fromfile=str(TARGET),
            tofile=f'{TARGET} (T3 Code)',
        )), end='')
        return
    if os.geteuid() != 0:
        raise SystemExit('Apply and rollback require root; check does not.')

    with open('/run/lock/t3code-caddy.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        current = TARGET.read_bytes()
        save_backup = False
        if action == 'apply':
            if digest(current) == EXPECTED_SHA256:
                next_config = proposed(current)
                if BACKUP.exists():
                    raise SystemExit('Backup already exists; stopped before overwriting it.')
                save_backup = True
            elif BACKUP.exists() and digest(current) == digest(proposed(BACKUP.read_bytes())):
                next_config = current
            else:
                raise SystemExit('Caddyfile differs from the reviewed versions; stopped.')
        else:
            if not BACKUP.exists() or digest(BACKUP.read_bytes()) != EXPECTED_SHA256:
                raise SystemExit('Reviewed backup is missing or changed; stopped.')
            if digest(current) != digest(proposed(BACKUP.read_bytes())):
                raise SystemExit('Live Caddyfile differs from the reviewed T3 version; stopped.')
            next_config = BACKUP.read_bytes()
        validate(next_config)
        if save_backup:
            BACKUP.write_bytes(current)
            BACKUP.chmod(TARGET.stat().st_mode & 0o777)
        atomic_write(next_config, digest(current))
        try:
            subprocess.run(['/usr/bin/systemctl', 'reload', 'caddy.service'], check=True)
        except subprocess.CalledProcessError:
            atomic_write(current, digest(next_config))
            subprocess.run(['/usr/bin/systemctl', 'reload', 'caddy.service'], check=False)
            raise SystemExit('Reload failed; previous Caddyfile restored.')
        print(f'Caddy {action} complete.')


if __name__ == '__main__':
    main()
