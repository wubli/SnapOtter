#!/usr/bin/env python3
"""Smoke-test the deployed Convert site. Paid tools run only with --ai."""

import argparse
import getpass
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid
import wave
import zlib
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin, urlsplit
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener


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
        self.http = build_opener(HTTPCookieProcessor(CookieJar()), NoRedirect())
        self.http.addheaders = [("User-Agent", "SnapOtter-Verify/1.0")]
        self.token = None
        self.wake_cookie = None

    def request(self, path, data=None, content_type=None, *, method=None, headers=None,
                accept=(), timeout=30):
        target = urljoin(self.url, path)
        location = urlsplit(target)
        if (location.scheme, location.netloc) != (self.origin.scheme, self.origin.netloc):
            raise ValueError("The server returned a URL outside the site origin.")
        headers = dict(headers or {})
        if self.wake_cookie:
            headers["Cookie"] = "__Host-snapotter-wake=" + self.wake_cookie
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        if content_type:
            headers["Content-Type"] = content_type
        try:
            request = Request(target, data=data, headers=headers, method=method)
            with self.http.open(request, timeout=timeout) as response:
                return response.status, response.headers, response.read()
        except HTTPError as exc:
            if exc.code in accept:
                with exc:
                    return exc.code, exc.headers, exc.read()
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

    def wake(self, cookie_file, timeout):
        if self.origin.scheme != "https":
            raise ValueError("Use HTTPS when supplying a wake cookie.")
        self.wake_cookie = read_wake_cookie(cookie_file)
        headers = {"Origin": self.url, "Sec-Fetch-Site": "same-origin"}
        deadline = time.monotonic() + timeout
        wake_again = 0
        rejected = "Wake cookie rejected. Sign in with Google in your browser and copy a fresh cookie."
        print("Waiting for SnapOtter.", flush=True)

        while (remaining := deadline - time.monotonic()) > 0:
            status, response_headers, body = self.request(
                "/_wake/status", accept=(401, 503), timeout=min(30, remaining),
            )
            if status == 401:
                raise RuntimeError(rejected)
            if status == 200 and json.loads(body).get("state") == "ready":
                print("Wake gateway reports SnapOtter ready.", flush=True)
                return
            delay = retry_delay(response_headers, default=3)
            remaining = deadline - time.monotonic()
            if time.monotonic() >= wake_again and remaining > 0:
                status, wake_headers, _ = self.request(
                    "/_wake", method="POST", headers=headers,
                    accept=(401, 503), timeout=min(30, remaining),
                )
                if status == 401:
                    raise RuntimeError(rejected)
                wake_again = time.monotonic() + retry_delay(wake_headers, default=12)
            time.sleep(max(0, min(delay, deadline - time.monotonic())))
        raise RuntimeError("Timed out waiting for SnapOtter to wake.")

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
        _, headers, content = self.request(result["downloadUrl"])
        if not content or len(content) != result["processedSize"]:
            raise RuntimeError(f"{path}: downloaded result is empty or differs from the reported size.")
        return headers.get_content_type(), content

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

def read_wake_cookie(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as file:
        mode = os.fstat(file.fileno()).st_mode
        if not stat.S_ISREG(mode) or (mode & (stat.S_IRWXG | stat.S_IRWXO)):
            raise ValueError("Store the wake cookie in a private regular file (mode 0600).")
        raw = file.read(1074)
    if len(raw) > 1073 or not re.fullmatch(
        rb"v2\.[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}\r?\n?", raw,
    ):
        raise ValueError("The file must contain only the signed v2 wake cookie value.")
    return raw.rstrip(b"\r\n").decode("ascii")


def retry_delay(headers, default):
    retry = headers.get("Retry-After", "")
    return max(1, int(retry)) if retry.isascii() and retry.isdecimal() else default


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


SPEECH_FIXTURES = (
    ("The blue bird sings by the river.", {"blue", "bird", "river"}),
    ("The yellow train arrives at noon.", {"yellow", "train", "noon"}),
)


def make_speech(directory):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("--ai requires FFmpeg with libflite, or FFmpeg and eSpeak.")
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    sample_rate = 16_000
    audio = directory / "speech.wav"
    video = directory / "speech.mp4"
    windows = []
    pcm = bytearray(b"\0" * (sample_rate * 2 * 2 // 5))  # 0.4 seconds of lead-in.
    for index, (sentence, _) in enumerate(SPEECH_FIXTURES):
        source = directory / f"voice-{index}.wav"
        if espeak:
            subprocess.run([espeak, "-v", "en-us", "-s", "135", "-w", str(source), sentence], check=True)
            speech = subprocess.check_output([
                ffmpeg, "-v", "error", "-i", str(source), "-ac", "1", "-ar", str(sample_rate),
                "-f", "s16le", "-",
            ])
        else:
            speech = subprocess.check_output([
                ffmpeg, "-v", "error", "-f", "lavfi", "-i", f"flite=text={sentence}:voice=slt",
                "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-",
            ])
        if index:
            pcm.extend(b"\0" * (sample_rate * 2 * 3))  # Three seconds between phrases.
        start = len(pcm) / (sample_rate * 2)
        pcm.extend(speech)
        windows.append((start, len(pcm) / (sample_rate * 2)))

    pcm.extend(b"\0" * (sample_rate * 2 * 2 // 5))
    with wave.open(str(audio), "wb") as wav:
        wav.setparams((1, 2, sample_rate, 0, "NONE", "not compressed"))
        wav.writeframes(pcm)

    subprocess.run(
        [
            ffmpeg, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x120:r=12",
            "-i", str(audio), "-c:v", "mpeg4", "-c:a", "aac", "-shortest", str(video),
        ],
        check=True,
    )
    return audio, video, windows


def includes_words(text, expected):
    words = set(re.findall(r"[a-z]+", text.lower().replace("bluebird", "blue bird")))
    return len(words & expected) >= 2


def subtitle_timing(data, format_name, windows):
    blocks = re.split(r"\n\s*\n", data.decode("utf-8").strip().replace("\r\n", "\n"))
    if format_name == "vtt" and blocks.pop(0) != "WEBVTT":
        return False
    if len(blocks) != len(windows):
        return False

    separator = r"\." if format_name == "vtt" else ","
    timecode = rf"(\d{{2}}):(\d{{2}}):(\d{{2}}){separator}(\d{{3}})"

    def seconds(fields):
        hour, minute, second, millisecond = map(int, fields)
        return hour * 3600 + minute * 60 + second + millisecond / 1000

    previous_end = 0
    for index, (block, (speech_start, speech_end)) in enumerate(zip(blocks, windows), start=1):
        lines = block.splitlines()
        if format_name == "srt" and lines.pop(0) != str(index):
            return False
        if len(lines) < 2 or not includes_words(" ".join(lines[1:]), SPEECH_FIXTURES[index - 1][1]):
            return False
        match = re.fullmatch(rf"{timecode} --> {timecode}", lines[0])
        if not match:
            return False
        start, end = seconds(match.groups()[:4]), seconds(match.groups()[4:])
        if not previous_end <= start < end:
            return False
        if abs(start - speech_start) > 1 or abs(end - speech_end) > 1:
            return False
        previous_end = end
    return True


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
        audio, video, windows = make_speech(directory)
        check_tool(
            "/api/v1/tools/audio/transcribe-audio", audio, "audio/wav",
            {"language": "en", "outputFormat": "txt"}, "speech.txt",
            lambda mime, data: mime == "text/plain"
            and all(includes_words(data.decode("utf-8"), words) for _, words in SPEECH_FIXTURES),
        )
        check_tool(
            "/api/v1/tools/video/auto-subtitles", video, "video/mp4",
            {"language": "en", "format": "srt"}, "speech.srt",
            lambda mime, data: mime == "application/x-subrip" and subtitle_timing(data, "srt", windows),
        )
        check_tool(
            "/api/v1/tools/audio/transcribe-audio", audio, "audio/wav",
            {"language": "en", "outputFormat": "vtt"}, "speech.vtt",
            lambda mime, data: mime == "text/vtt" and subtitle_timing(data, "vtt", windows),
        )

    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        for filename, content in results.items():
            (output_dir / filename).write_bytes(content)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="https://convert.henesys.shop", help="Site origin")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--wake-cookie-file", type=Path, help="Read a signed wake cookie from a private file")
    parser.add_argument("--wake-timeout", type=int, default=180, help="Seconds to wait for SnapOtter to wake")
    parser.add_argument("--password-file", type=Path, help="Read the login password from this file")
    parser.add_argument("--change-password", action="store_true", help="Prompt to rotate the bootstrap password if required")
    ai = parser.add_mutually_exclusive_group()
    ai.add_argument("--ai", action="store_true", help="Run three paid transcription checks using the server's key")
    ai.add_argument("--skip-ai", dest="ai", action="store_false", help="Run without paid tools (default)")
    parser.set_defaults(ai=False)
    parser.add_argument("--job-timeout", type=int, default=180, help="Seconds to wait for each queued job")
    parser.add_argument("--output-dir", type=Path, help="Save verified downloads to this directory")
    args = parser.parse_args()
    if args.job_timeout <= 0:
        parser.error("--job-timeout must be positive")

    if args.wake_timeout <= 0:
        parser.error("--wake-timeout must be positive")

    site = Site(args.url)
    if args.wake_cookie_file:
        site.wake(args.wake_cookie_file, args.wake_timeout)
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
