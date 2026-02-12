#!/usr/bin/env python3
import argparse
import os
import ssl
import subprocess
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def ensure_cert(cert_path: Path, key_path: Path, cn: str) -> None:
    if cert_path.exists() and key_path.exists():
        return

    cert_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.parent.mkdir(parents=True, exist_ok=True)

    openssl = "openssl"
    conf = f"""[req]
distinguished_name=req_distinguished_name
x509_extensions=v3_req
prompt = no

[req_distinguished_name]
CN = {cn}

[v3_req]
subjectAltName = @alt_names
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
"""

    with tempfile.NamedTemporaryFile("w", delete=False) as f:
        f.write(conf)
        conf_path = f.name

    try:
        cmd = [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(key_path),
            "-out",
            str(cert_path),
            "-days",
            "365",
            "-config",
            conf_path,
            "-extensions",
            "v3_req",
        ]
        res = subprocess.run(cmd, check=False, capture_output=True, text=True)
        if res.returncode != 0:
            sys.stderr.write("Failed to generate certificate with openssl.\n")
            sys.stderr.write(res.stdout + "\n" + res.stderr + "\n")
            sys.stderr.write("Make sure openssl is installed, or provide --cert/--key.\n")
            raise SystemExit(1)
    finally:
        try:
            os.unlink(conf_path)
        except OSError:
            pass


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    project_root = repo_root.parent
    parser = argparse.ArgumentParser(description="Local HTTPS server for Web Bluetooth testing.")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8443, help="Port (default: 8443)")
    parser.add_argument(
        "--dir",
        default=str(project_root),
        help=f"Directory to serve (default: {project_root})",
    )
    parser.add_argument("--cert", default="certs/localhost.crt", help="Certificate path")
    parser.add_argument("--key", default="certs/localhost.key", help="Private key path")
    parser.add_argument("--cn", default="localhost", help="Certificate common name (default: localhost)")
    args = parser.parse_args()

    cert_path = Path(args.cert).resolve()
    key_path = Path(args.key).resolve()

    ensure_cert(cert_path, key_path, args.cn)

    os.chdir(args.dir)

    httpd = ThreadingHTTPServer((args.host, args.port), SimpleHTTPRequestHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)

    print(f"Serving HTTPS on https://{args.host}:{args.port} (dir: {os.getcwd()})")
    print("If the browser warns about the cert, accept the exception once.")
    print("Web Bluetooth works only on secure contexts (HTTPS/localhost).")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
