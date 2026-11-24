#!/usr/bin/env python3
"""Synthetic installer checks that need no root, credential, or cloud call."""

import io
import json
import os
import runpy
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

installer = runpy.run_path(str(Path(__file__).with_name("install-google-oidc-client.py")))
CALLBACK = installer["CALLBACK"]
InstallError = installer["InstallError"]
install_client = installer["install_client"]
read_client = installer["read_client"]
CLIENT_ID = "1234567890-abcdefghijk.apps.googleusercontent.com"
OTHER_CLIENT_ID = "9876543210-zyxwvutsr.apps.googleusercontent.com"
CLIENT_SECRET = "fixture-secret-no-real-value"


def web_client(**changes):
    web = {"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET, "redirect_uris": [CALLBACK]}
    web.update(changes)
    return io.BytesIO(json.dumps({"web": web}).encode())


class ClientInstallationTest(unittest.TestCase):
    def test_accepts_original_web_credentials_with_exact_callback(self):
        self.assertEqual(read_client(web_client()), (CLIENT_ID, CLIENT_SECRET))
        self.assertEqual(
            read_client(web_client(redirect_uris=["http://localhost", CALLBACK])),
            (CLIENT_ID, CLIENT_SECRET),
        )

    def test_accepts_an_opaque_client_id_and_printable_legacy_secret(self):
        client_id = "different-layout.apps.googleusercontent.com"
        secret = 'legacy+secret!=with$punctuation'
        self.assertEqual(
            read_client(web_client(client_id=client_id, client_secret=secret)),
            (client_id, secret),
        )

    def test_rejects_invalid_documents_without_disclosing_values(self):
        invalid = [
            io.BytesIO(b"{}"),
            io.BytesIO(b'{"installed":{}}'),
            io.BytesIO(b'{"web": {}, "web": {}}'),
            io.BytesIO(b"\xff"),
            io.BytesIO(b" " * (installer["MAX_INPUT_BYTES"] + 1)),
            web_client(client_id="https://my-insecure-oauth-client"),
            web_client(client_secret=CLIENT_SECRET + "\nFORGED=secret"),
            web_client(redirect_uris=[CALLBACK + "/"]),
        ]
        for stream in invalid:
            with self.subTest():
                with self.assertRaises(InstallError) as failure:
                    read_client(stream)
                self.assertNotIn(CLIENT_SECRET, str(failure.exception))

    def test_publishes_a_private_pair_and_repeat_install_keeps_its_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            deployment = Path(tmp)
            dotenv = deployment / ".env"
            dotenv.write_text("UNRELATED_SETTING=retain\n")
            self.assertTrue(install_client(deployment, CLIENT_ID, CLIENT_SECRET))

            pointer = deployment / "secrets" / "google-oidc-current"
            previous = pointer.readlink()
            self.assertEqual((pointer / "client.env").read_text(), f"OIDC_CLIENT_ID={CLIENT_ID}\n")
            self.assertEqual((pointer / "client_secret").read_text(), CLIENT_SECRET + "\n")
            self.assertEqual(stat.S_IMODE((pointer / "client.env").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((pointer / "client_secret").stat().st_mode), 0o400)
            self.assertEqual(stat.S_IMODE(pointer.stat().st_mode), 0o700)
            self.assertEqual(dotenv.read_text(), "UNRELATED_SETTING=retain\n")

            self.assertFalse(install_client(deployment, CLIENT_ID, CLIENT_SECRET))
            self.assertEqual(pointer.readlink(), previous)
            self.assertTrue(install_client(deployment, OTHER_CLIENT_ID, "new-fixture-client-secret"))
            self.assertNotEqual(pointer.readlink(), previous)
            self.assertEqual((pointer / "client.env").read_text(), f"OIDC_CLIENT_ID={OTHER_CLIENT_ID}\n")
            self.assertEqual((pointer / "client_secret").read_text(), "new-fixture-client-secret\n")
            self.assertEqual((pointer.parent / previous / "client_secret").read_text(), CLIENT_SECRET + "\n")

    def test_keeps_the_previous_pair_when_publication_is_interrupted(self):
        with tempfile.TemporaryDirectory() as tmp:
            deployment = Path(tmp)
            install_client(deployment, CLIENT_ID, CLIENT_SECRET)
            secrets = deployment / "secrets"
            pointer = secrets / "google-oidc-current"
            previous = pointer.readlink()
            with mock.patch.object(os, "replace", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
                install_client(deployment, OTHER_CLIENT_ID, "new-fixture-client-secret")
            self.assertEqual(pointer.readlink(), previous)
            self.assertEqual((pointer / "client_secret").read_text(), CLIENT_SECRET + "\n")
            self.assertEqual(sorted(path.name for path in secrets.iterdir()), [previous.name, pointer.name])

    def test_interruption_after_rename_leaves_the_new_pair_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            deployment = Path(tmp)
            install_client(deployment, CLIENT_ID, CLIENT_SECRET)
            replace = os.replace

            def replace_then_interrupt(*args, **kwargs):
                replace(*args, **kwargs)
                raise KeyboardInterrupt

            with mock.patch.object(os, "replace", side_effect=replace_then_interrupt), self.assertRaises(KeyboardInterrupt):
                install_client(deployment, OTHER_CLIENT_ID, "new-fixture-client-secret")
            pointer = deployment / "secrets" / "google-oidc-current"
            self.assertEqual((pointer / "client.env").read_text(), f"OIDC_CLIENT_ID={OTHER_CLIENT_ID}\n")
            self.assertEqual((pointer / "client_secret").read_text(), "new-fixture-client-secret\n")

    def test_rejects_a_secrets_directory_writable_by_other_users(self):
        with tempfile.TemporaryDirectory() as tmp:
            deployment = Path(tmp)
            secrets = deployment / "secrets"
            secrets.mkdir()
            secrets.chmod(0o777)
            with self.assertRaises(InstallError):
                install_client(deployment, CLIENT_ID, CLIENT_SECRET)
            self.assertEqual(list(secrets.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
