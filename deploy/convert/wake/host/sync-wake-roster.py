#!/usr/bin/env python3
"""Publish approved PostgreSQL users to the Google wake gate."""

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

DEPLOYMENT = Path("/opt/snapotter")
STATE = Path("/run/snapotter-wake-roster")
DESTINATION = "https://convert.henesys.shop/_wake/roster"
TOKEN_CONTEXT = b"snapotter-google-roster-v1"
MAX_USERS = 512
MAX_BYTES = 256 * 1024
EMAIL = re.compile(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,128}@[a-z0-9.-]{1,190}")
SUBJECT = re.compile(r"[A-Za-z0-9._-]{1,255}")
QUERY = """
SELECT COALESCE(json_agg(json_build_object('email', email, 'sub', sub)), '[]'::json)
FROM (
  SELECT email, external_id AS sub
  FROM public.users
  WHERE google_wake_approved AND id <> 'anonymous'
    AND role <> 'disabled' AND role NOT LIKE 'disabled:%'
    AND email IS NOT NULL
  ORDER BY email COLLATE "C"
  LIMIT 513
) AS approved;
"""


class SyncError(Exception):
    """An operator-facing error that contains no identities or credentials."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def encode_roster(data):
    if not isinstance(data, list) or len(data) > MAX_USERS:
        raise SyncError("The database returned an invalid or oversized wake roster.")
    users = {}
    for user in data:
        if not isinstance(user, dict):
            raise SyncError("The database returned an invalid wake identity.")
        email, sub = user.get("email"), user.get("sub")
        if (
            not isinstance(email, str) or not email.isascii() or email != email.lower()
            or not EMAIL.fullmatch(email) or email in users
            or (sub is not None and (not isinstance(sub, str) or not SUBJECT.fullmatch(sub)))
        ):
            raise SyncError("The database returned an invalid or duplicate wake identity.")
        users[email] = sub
    snapshot = {"users": [{"email": email, "sub": users[email]} for email in sorted(users)]}
    body = json.dumps(snapshot, separators=(",", ":")).encode("ascii")
    if len(body) > MAX_BYTES:
        raise SyncError("The wake roster exceeds the publication size limit.")
    return body


def load_roster():
    try:
        result = subprocess.run(
            [
                "docker", "compose", "exec", "-T", "postgres", "psql",
                "-X", "-qAt", "-U", "snapotter", "-d", "snapotter", "-v", "ON_ERROR_STOP=1",
                "-c", QUERY,
            ],
            cwd=DEPLOYMENT,
            capture_output=True,
            check=True,
            timeout=8,
        )
        data = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise SyncError("The approved Google users are unavailable from PostgreSQL.") from error
    return encode_roster(data)


def publish(body):
    try:
        origin_token = (DEPLOYMENT / "secrets/origin_token").read_bytes().strip()
    except OSError as error:
        raise SyncError("The local origin token is unavailable.") from error
    if not origin_token:
        raise SyncError("The local origin token is empty.")
    authorization = hmac.new(origin_token, TOKEN_CONTEXT, hashlib.sha256).hexdigest()
    request = Request(
        DESTINATION,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "SnapOtter-Roster/1.0",
            "X-SnapOtter-Roster-Token": authorization,
        },
    )
    try:
        with build_opener(NoRedirect()).open(request, timeout=10) as response:
            if response.status != 204:
                raise SyncError(f"Wake gateway returned unexpected HTTP {response.status}.")
    except HTTPError as error:
        error.close()
        raise SyncError(f"Wake gateway rejected the roster (HTTP {error.code}).") from error
    except (TimeoutError, URLError) as error:
        raise SyncError("The wake gateway did not acknowledge the roster.") from error


def sync_roster(force):
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    digest_path = STATE / "digest"
    with (STATE / "publisher.lock").open("ab") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SyncError("Another wake roster publication is in progress.") from error

        body = load_roster()
        digest = hashlib.sha256(body).hexdigest()
        if not force and digest_path.exists() and digest_path.read_text().strip() == digest:
            return
        # A timed-out request may still have reached the edge. Keep no local
        # acknowledgement until the latest snapshot has been confirmed again.
        digest_path.unlink(missing_ok=True)
        publish(body)
        with tempfile.NamedTemporaryFile(mode="w", dir=STATE, delete=False) as temporary:
            temporary.write(digest + "\n")
        pending = Path(temporary.name)
        try:
            pending.replace(digest_path)
        finally:
            pending.unlink(missing_ok=True)
        print("Wake gateway acknowledged the approved Google users.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="Require a fresh gateway acknowledgement")
    arguments = parser.parse_args()
    try:
        sync_roster(arguments.force)
    except SyncError as error:
        sys.exit(str(error))
    except (OSError, ValueError):
        sys.exit("Could not read or update local wake roster state.")


if __name__ == "__main__":
    main()
