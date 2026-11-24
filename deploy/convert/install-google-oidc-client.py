#!/usr/bin/env python3
"""Install a Google Web OAuth client credential pair from JSON on standard input."""

import argparse
import fcntl
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path

CALLBACK = "https://convert.henesys.shop/api/auth/oidc/callback"
MAX_INPUT_BYTES = 64 * 1024
CLIENT_ID = re.compile(r"[A-Za-z0-9_.-]{1,256}\.apps\.googleusercontent\.com")
CLIENT_SECRET = re.compile(r"[\x20-\x7e]{1,512}")
GENERATION = re.compile(r"\.google-oidc-[a-z0-9_]{8}")
CURRENT_NAME = "google-oidc-current"


class InstallError(Exception):
    """An error message safe to show without printing the supplied JSON."""


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InstallError("The client JSON contains duplicate fields.")
        result[key] = value
    return result


def read_client(stream):
    try:
        raw = stream.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise InstallError("The client JSON exceeds 64 KiB.")
        document = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, RecursionError) as error:
        raise InstallError("Expected a Google web OAuth client JSON document.") from error

    web = document.get("web") if isinstance(document, dict) and "installed" not in document else None
    if not isinstance(web, dict):
        raise InstallError("Expected the Google web client JSON, not a desktop client.")
    client_id = web.get("client_id")
    secret = web.get("client_secret")
    if not isinstance(client_id, str) or not CLIENT_ID.fullmatch(client_id):
        raise InstallError("The web client ID has an invalid format.")
    if not isinstance(secret, str) or not CLIENT_SECRET.fullmatch(secret) or secret != secret.strip():
        raise InstallError("The web client secret has an invalid format.")
    redirects = web.get("redirect_uris")
    if not isinstance(redirects, list) or CALLBACK not in redirects:
        raise InstallError(f"Register exactly {CALLBACK} as an authorized redirect URI before installation.")

    return client_id, secret


def open_directory(path, *, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    denied_permissions = 0o077 if private else 0o022
    if info.st_uid != os.geteuid() or info.st_mode & denied_permissions:
        os.close(fd)
        raise InstallError("The deployment and secrets directories must have a trusted owner and permissions.")
    return fd


def read_private_file(directory_fd, name, mode):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if info.st_uid != os.geteuid() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != mode:
            raise InstallError("An existing Google credential file has unsafe ownership or permissions.")
        return file.read(1024)


def write_private_file(directory_fd, name, content, mode):
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=directory_fd)
    with os.fdopen(fd, "wb") as file:
        file.write(content)
        file.flush()
        os.fsync(file.fileno())


def read_current(secrets, secrets_fd):
    try:
        target = os.readlink(CURRENT_NAME, dir_fd=secrets_fd)
    except FileNotFoundError:
        return None
    if not GENERATION.fullmatch(target):
        raise InstallError("The current Google credential link does not name an installer generation.")
    fd = open_directory(secrets / target, private=True)
    try:
        return (read_private_file(fd, "client.env", 0o600), read_private_file(fd, "client_secret", 0o400))
    finally:
        os.close(fd)


def install_client(deployment, client_id, secret):
    directory_fd = open_directory(deployment)
    secrets = deployment / "secrets"
    try:
        try:
            os.mkdir("secrets", 0o700, dir_fd=directory_fd)
            os.fsync(directory_fd)
        except FileExistsError:
            pass

        secrets_fd = open_directory(secrets, private=True)
        try:
            fcntl.flock(secrets_fd, fcntl.LOCK_EX)
            return publish_client(secrets, secrets_fd, client_id, secret)
        finally:
            os.close(secrets_fd)
    finally:
        os.close(directory_fd)


def publish_client(secrets, secrets_fd, client_id, secret):
    client_env = f"OIDC_CLIENT_ID={client_id}\n".encode("ascii")
    client_secret = f"{secret}\n".encode("ascii")
    if read_current(secrets, secrets_fd) == (client_env, client_secret):
        return False

    staging = Path(tempfile.mkdtemp(prefix=".google-oidc-", dir=secrets))
    link_name = staging.name + ".link"
    try:
        staging_fd = open_directory(staging, private=True)
        try:
            write_private_file(staging_fd, "client.env", client_env, 0o600)
            write_private_file(staging_fd, "client_secret", client_secret, 0o400)
            os.fsync(staging_fd)
        finally:
            os.close(staging_fd)
        os.symlink(staging.name, link_name, dir_fd=secrets_fd)
        os.fsync(secrets_fd)
        os.replace(link_name, CURRENT_NAME, src_dir_fd=secrets_fd, dst_dir_fd=secrets_fd)
        os.fsync(secrets_fd)
    finally:
        # Inspect the pointer itself in case an interruption follows the rename.
        try:
            selected = os.readlink(CURRENT_NAME, dir_fd=secrets_fd)
        except FileNotFoundError:
            selected = None
        if selected != staging.name:
            (secrets / link_name).unlink(missing_ok=True)
            shutil.rmtree(staging)
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment-dir", type=Path, default=Path("/opt/snapotter"))
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.exit(1, "Run the credential installer as root on the SnapOtter host.\n")
    os.umask(0o077)
    try:
        client_id, secret = read_client(sys.stdin.buffer)
        changed = install_client(args.deployment_dir, client_id, secret)
    except InstallError as error:
        parser.exit(1, f"{error}\n")
    except OSError:
        parser.exit(1, "Could not safely install the Google OAuth credentials. Check deployment ownership and write access.\n")
    except KeyboardInterrupt:
        parser.exit(130, "Credential installation interrupted.\n")
    print("Google OAuth credentials installed." if changed else "Google OAuth credentials already current.")


if __name__ == "__main__":
    main()
