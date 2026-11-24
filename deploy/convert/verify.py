#!/usr/bin/env python3
"""Smoke-test the deployed Convert site. Paid tools run only with --ai."""

import argparse
import getpass
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import zlib
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Site:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.origin = urlsplit(self.url)
        if self.origin.scheme != "https" and not (
            self.origin.scheme == "http" and self.origin.hostname in ("localhost", "127.0.0.1", "::1")
        ):
            raise ValueError("Use HTTPS for remote verification or HTTP on loopback.")
        if (not self.origin.hostname or self.origin.username or self.origin.password
                or self.origin.path or self.origin.query or self.origin.fragment):
            raise ValueError("Supply a site origin without a path, credentials, query, or fragment.")
        self.http = build_opener(NoRedirect())
        self.token = None

    def request(self, path, data=None, content_type=None):
        target = urljoin(self.url, path)
        location = urlsplit(target)
        if (location.scheme, location.netloc) != (self.origin.scheme, self.origin.netloc):
            raise ValueError("The server returned a URL outside the site origin.")
        headers = {}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if content_type:
            headers["Content-Type"] = content_type
        try:
            with self.http.open(Request(target, data=data, headers=headers), timeout=30) as response:
                return response.status, response.headers.get_content_type(), response.read()
        except HTTPError as exc:
            detail = ""
            try:
                payload = json.loads(exc.read(4096))
                detail = str(payload.get("message") or payload.get("error") or "")
            except (ValueError, AttributeError):
                pass
            raise RuntimeError(f"{location.path}: HTTP {exc.code} {detail}".rstrip()) from None

    def json(self, path, payload=None):
        if payload is None:
            _, _, body = self.request(path)
        else:
            _, _, body = self.request(path, json.dumps(payload).encode(), "application/json")
        return json.loads(body)

    def login(self, username, password):
        session = self.json("/api/auth/login", {"username": username, "password": password})
        self.token = session["token"]
        return session["user"]

    def run_tool(self, path, source, mime, settings, timeout):
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="settings"\r\n\r\n'
            f"{json.dumps(settings)}\r\n"
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{source.name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n"
        ).encode() + source.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
        status, _, response = self.request(path, body, f"multipart/form-data; boundary={boundary}")
        result = json.loads(response)
        if status == 202:
            result = self.wait_for_job(result["jobId"], timeout)
        _, content_type, content = self.request(result["downloadUrl"])
        if not content or len(content) != result["processedSize"]:
            raise RuntimeError(f"{path}: downloaded result is empty or differs from the reported size.")
        return content_type, content

    def wait_for_job(self, job_id, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.json("/api/v1/jobs/" + quote(job_id, safe=""))
            status = job["status"]
            if status == "completed":
                return job["result"]
            if status in ("failed", "canceled", "cancelled"):
                detail = job.get("error", {}).get("message", "")
                raise RuntimeError(f"Job {job_id} {status}. {detail}".rstrip())
            time.sleep(2)
        raise RuntimeError(f"Timed out waiting for job {job_id}.")


def write_png(path, width, height, pixels):
    def chunk(kind, payload):
        data = kind + payload
        return struct.pack(">I", len(payload)) + data + struct.pack(">I", zlib.crc32(data))

    stride = width * 3
    rows = b"".join(b"\0" + pixels[start:start + stride] for start in range(0, len(pixels), stride))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def make_ocr_png(path):
    # A scalable 5x7 fixture font for the exact text "TEST OCR".
    glyphs = {
        "T": [31, 4, 4, 4, 4, 4, 4],
        "E": [31, 16, 16, 30, 16, 16, 31],
        "S": [15, 16, 16, 14, 1, 1, 30],
        " ": [0] * 7,
        "O": [14, 17, 17, 17, 17, 17, 14],
        "C": [14, 17, 16, 16, 16, 17, 14],
        "R": [30, 17, 17, 30, 20, 18, 17],
    }
    scale, margin = 12, 36
    text = "TEST OCR"
    width, height = len(text) * 6 * scale + 2 * margin, 7 * scale + 2 * margin
    pixels = bytearray(b"\xff" * (width * height * 3))
    for index, char in enumerate(text):
        for y, row in enumerate(glyphs[char]):
            for x in range(5):
                if row & (1 << (4 - x)):
                    left = margin + (index * 6 + x) * scale
                    for raster_y in range(margin + y * scale, margin + (y + 1) * scale):
                        start = (raster_y * width + left) * 3
                        pixels[start:start + scale * 3] = bytes(scale * 3)
    write_png(path, width, height, pixels)


def make_ocr_pdf(path):
    def text_stream(text):
        content = f"BT /F1 32 Tf 52 300 Td ({text}) Tj ET"
        return f"<< /Length {len(content)} >>\nstream\n{content}\nendstream"

    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 405] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 540 405] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        text_stream("Omit this page 4930"),
        text_stream("Native PDF OCR 7614"),
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = ["0000000000 65535 f \n"]
    for index, obj in enumerate(objects, start=1):
        offsets.append(f"{len(pdf):010d} 00000 n \n")
        pdf.extend(f"{index} 0 obj\n{obj}\nendobj\n".encode("ascii"))
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(offsets)}\n{''.join(offsets)}".encode("ascii"))
    pdf.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii"))
    path.write_bytes(pdf)


def make_speech(directory):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("--ai requires FFmpeg. Install a build with libflite or install eSpeak.")
    wave = directory / "speech.wav"
    video = directory / "speech.mp4"
    phrase = "The blue bird sings by the river. The blue bird sings by the river."
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    if espeak:
        subprocess.run([espeak, "-v", "en-us", "-s", "135", "-w", str(wave), phrase], check=True)
    else:
        subprocess.run(
            [ffmpeg, "-v", "error", "-f", "lavfi", "-i", f"flite=text={phrase}:voice=slt", str(wave)],
            check=True,
        )
    subprocess.run(
        [
            ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=12",
            "-i", str(wave), "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(video),
        ],
        check=True,
    )
    return wave, video


def verify_tools(site, directory, ai, timeout, output_dir):
    results = {}

    def check_tool(path, file, mime, settings, output, validate):
        content_type, content = site.run_tool(path, file, mime, settings, timeout)
        if not validate(content_type, content):
            raise RuntimeError(f"{path}: invalid result for {output}.")
        results[output] = content
        print(f"{output}: verified {len(content)} downloaded bytes.", flush=True)

    image = directory / "conversion.png"
    write_png(image, 16, 16, b"\x20\x80\xe0" * 256)
    check_tool(
        "/api/v1/tools/image/convert", image, "image/png", {"format": "jpg"}, "conversion.jpg",
        lambda mime, data: mime == "image/jpeg" and data.startswith(b"\xff\xd8\xff")
        and data.endswith(b"\xff\xd9"),
    )

    ocr_image = directory / "ocr.png"
    make_ocr_png(ocr_image)
    check_tool(
        "/api/v1/tools/image/ocr", ocr_image, "image/png",
        {"language": "en"}, "ocr-image.txt",
        lambda mime, data: mime == "text/plain" and b"TEST OCR" in b" ".join(data.upper().split()),
    )

    ocr_pdf = directory / "ocr.pdf"
    make_ocr_pdf(ocr_pdf)
    check_tool(
        "/api/v1/tools/pdf/ocr-pdf", ocr_pdf, "application/pdf",
        {"language": "en", "quality": "fast", "pages": "2"}, "ocr-pdf.txt",
        lambda mime, data: mime == "text/plain" and b"--- Page 2 ---" in data
        and b"Native PDF OCR 7614" in data and b"4930" not in data,
    )

    if ai:
        def includes_speech(data):
            transcript = data.decode("utf-8").lower().replace("bluebird", "blue bird")
            words = set(re.findall(r"[a-z]+", transcript))
            return len(words & {"blue", "bird", "river"}) >= 2

        wave, video = make_speech(directory)
        check_tool(
            "/api/v1/tools/audio/transcribe-audio", wave, "audio/wav",
            {"language": "en", "outputFormat": "txt"}, "speech.txt",
            lambda mime, data: mime == "text/plain" and includes_speech(data),
        )
        check_tool(
            "/api/v1/tools/video/auto-subtitles", video, "video/mp4",
            {"language": "en", "format": "srt"}, "speech.srt",
            lambda mime, data: mime == "application/x-subrip" and includes_speech(data)
            and re.search(rb"\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}", data),
        )

    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        for filename, content in results.items():
            (output_dir / filename).write_bytes(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://convert.henesys.shop", help="Site origin")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password-file", type=Path, help="Read the login password from this file")
    parser.add_argument("--change-password", action="store_true", help="Prompt to rotate the bootstrap password if required")
    ai = parser.add_mutually_exclusive_group()
    ai.add_argument("--ai", action="store_true", help="Run two paid transcription checks using the server's key")
    ai.add_argument("--skip-ai", dest="ai", action="store_false", help="Run without paid tools (default)")
    parser.set_defaults(ai=False)
    parser.add_argument("--job-timeout", type=int, default=180, help="Seconds to wait for each queued job")
    parser.add_argument("--output-dir", type=Path, help="Save verified downloads to this directory")
    args = parser.parse_args()
    if args.job_timeout <= 0:
        parser.error("--job-timeout must be positive")

    site = Site(args.url)
    if site.json("/api/v1/health").get("status") != "healthy":
        raise RuntimeError("SnapOtter health endpoint did not report healthy.")

    password = (
        args.password_file.read_text().rstrip("\r\n") if args.password_file
        else getpass.getpass(f"Password for {args.username}: ")
    )
    user = site.login(args.username, password)
    if user["mustChangePassword"]:
        if not args.change_password:
            raise RuntimeError("First login requires a password change. Use --change-password or sign in with a browser.")
        new_password = getpass.getpass("New admin password: ")
        if new_password == password or new_password != getpass.getpass("Confirm new admin password: "):
            raise RuntimeError("Choose a different password and enter the same value twice.")
        site.json("/api/auth/change-password", {"currentPassword": password, "newPassword": new_password})
        user = site.login(args.username, new_password)
        if user["mustChangePassword"]:
            raise RuntimeError("The account still requires a password change.")
    print(f"Signed in as {user['username']}.", flush=True)

    with tempfile.TemporaryDirectory(prefix="snapotter-verify-") as directory:
        verify_tools(site, Path(directory), args.ai, args.job_timeout, args.output_dir)
    if not args.ai:
        print("Paid AI checks skipped.")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, OSError, RuntimeError, URLError, ValueError, subprocess.CalledProcessError) as error:
        sys.exit(f"Verification failed: {error}")
