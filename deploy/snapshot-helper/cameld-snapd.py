#!/usr/bin/env python3
"""cameld snapshot helper: takes a ZFS snapshot of ONE dataset on request.

The cameld container has no privileges and no Docker socket. Before every
delete it asks this helper for a snapshot (docs/ARCHITECTURE.md section 7):

    POST /snapshot
    authorization: Bearer <token>
    content-type: application/json
    {"label": "<a-z 0-9 _ -, 1..64 chars>"}

    200 {"snapshot": "<dataset>@cameld-<label>-<UTC stamp>"}
    anything else: no snapshot was taken

    GET /healthz -> 200 "ok" (no auth, takes nothing)

The dataset comes from the command line, never from the request. The helper
runs as a dedicated non-root host user whose only ZFS right is a delegated
`snapshot` on that dataset (`zfs allow -l -u <user> snapshot <dataset>`), so
even a compromised helper cannot destroy, roll back, rename or modify
anything. Standard library only (TrueNAS ships python3, nothing else).

Usage:
    cameld-snapd.py --dataset POOL/apps/cameld --token-file FILE [--bind ADDR] [--port N]
"""

import argparse
import hmac
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

LABEL = re.compile(r"^[a-z0-9_-]{1,64}$")
DATASET = re.compile(r"^[A-Za-z0-9_.:-]+(/[A-Za-z0-9_.:-]+)*$")
ZFS = "/usr/sbin/zfs"
MAX_BODY = 1024
# At most this many snapshots per rolling hour; more is a bug or abuse.
RATE_LIMIT = 120


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"{stamp} {message}", file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "cameld-snapd"
    sys_version = ""
    timeout = 10
    dataset = ""
    token = b""
    recent: list = []

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        log(f"{self.client_address[0]} {format % args}")

    def reply(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/snapshot":
            return self.reply(404, {"error": "not found"})
        auth = self.headers.get("authorization", "")
        presented = auth[7:].encode() if auth.startswith("Bearer ") else b""
        if not hmac.compare_digest(presented, self.token):
            return self.reply(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = -1
        if length < 1 or length > MAX_BODY:
            return self.reply(400, {"error": "bad body"})
        try:
            label = json.loads(self.rfile.read(length)).get("label")
        except (ValueError, AttributeError):
            return self.reply(400, {"error": "bad body"})
        if not isinstance(label, str) or not LABEL.match(label):
            return self.reply(400, {"error": "label must match [a-z0-9_-]{1,64}"})

        now = time.monotonic()
        Handler.recent = [t for t in Handler.recent if now - t < 3600]
        if len(Handler.recent) >= RATE_LIMIT:
            return self.reply(429, {"error": "rate limited"})
        Handler.recent.append(now)

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        full = f"{self.dataset}@cameld-{label}-{stamp}"
        try:
            made = subprocess.run(
                [ZFS, "snapshot", full], capture_output=True, text=True, timeout=60
            )
            if made.returncode != 0:
                log(f"zfs snapshot {full} failed: {made.stderr.strip()}")
                return self.reply(500, {"error": "snapshot failed"})
            seen = subprocess.run(
                [ZFS, "list", "-H", "-o", "name", "-t", "snapshot", full],
                capture_output=True,
                text=True,
                timeout=60,
            )
        except subprocess.TimeoutExpired:
            log(f"zfs timed out for {full}")
            return self.reply(500, {"error": "snapshot timed out"})
        if seen.returncode != 0 or seen.stdout.strip() != full:
            log(f"snapshot {full} not found after create")
            return self.reply(500, {"error": "snapshot not found after create"})
        log(f"snapshot {full}")
        return self.reply(200, {"snapshot": full})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9131)
    args = parser.parse_args()
    if not DATASET.match(args.dataset):
        sys.exit("bad --dataset")
    with open(args.token_file, "rb") as handle:
        token = handle.read().strip()
    if len(token) < 32:
        sys.exit("token must be at least 32 characters")
    Handler.dataset = args.dataset
    Handler.token = token
    server = HTTPServer((args.bind, args.port), Handler)
    log(f"listening on {args.bind}:{args.port} for {args.dataset}")
    server.serve_forever()


if __name__ == "__main__":
    main()
