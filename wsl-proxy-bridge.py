#!/usr/bin/env python3
"""Local WSL bridge to a Windows-loopback proxy, using stdio for each stream.

`--ensure` starts a single per-user local server or verifies the existing one.
The listener is restricted to WSL loopback. It never opens a Windows listener.
"""
import argparse
import fcntl
import hashlib
import hmac
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time

HOST = '127.0.0.1'
DEFAULT_PORT = 18765
PREFIX = b'\0TMUX-WSL-PROXY '
NODE = '/mnt/c/Program Files/nodejs/node.exe'
CLIENT = Path(__file__).resolve().with_name('wsl-proxy-client.cjs')


def load_token(state):
    path = state / 'token'
    try:
        token = path.read_bytes()
        if len(token) != 32:
            raise RuntimeError('invalid bridge token')
        return token
    except FileNotFoundError:
        token = secrets.token_bytes(32)
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(token)
        return token


def verified(port, token):
    nonce = secrets.token_hex(16).encode('ascii')
    expected = hmac.new(token, nonce, hashlib.sha256).hexdigest().encode('ascii') + b'\n'
    try:
        with socket.create_connection((HOST, port), timeout=1) as conn:
            conn.settimeout(1)
            conn.sendall(PREFIX + nonce + b'\n')
            response = b''
            while b'\n' not in response and len(response) <= 128:
                data = conn.recv(128)
                if not data:
                    break
                response += data
            return hmac.compare_digest(response, expected)
    except OSError:
        return False


def listener_exists(port):
    try:
        with socket.create_connection((HOST, port), timeout=1):
            return True
    except OSError:
        return False


def ensure(port, state):
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not state.is_dir() or state.is_symlink():
        raise RuntimeError('invalid bridge state directory')
    os.chmod(state, 0o700)
    with open(state / 'lock', 'a+b') as lock:
        os.chmod(state / 'lock', 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        token = load_token(state)
        if verified(port, token):
            return
        if listener_exists(port):
            raise RuntimeError('local bridge port is occupied by an unverified service')
        if not os.path.isfile(NODE) or not CLIENT.is_file():
            raise RuntimeError('Windows Node or the proxy client is unavailable')
        subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--serve',
                          '--port', str(port), '--state-dir', str(state)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        end = time.monotonic() + 7
        while time.monotonic() < end:
            if verified(port, token):
                return
            time.sleep(.1)
        raise RuntimeError('local proxy bridge did not start')


def relay(conn, client_path):
    proc = None
    try:
        conn.settimeout(5)
        first = conn.recv(1, socket.MSG_PEEK)
        if not first:
            return
        if first == b'\0':
            deadline = time.monotonic() + 5
            while True:
                first = conn.recv(len(PREFIX), socket.MSG_PEEK)
                if not first or not PREFIX.startswith(first) or len(first) == len(PREFIX):
                    break
                if time.monotonic() >= deadline:
                    return
                time.sleep(.01)
        if first == PREFIX:
            request = b''
            while b'\n' not in request and len(request) < 128:
                part = conn.recv(128 - len(request))
                if not part:
                    return
                request += part
            if request.startswith(PREFIX) and request.endswith(b'\n'):
                nonce = request[len(PREFIX):-1]
                if len(nonce) == 32 and all(c in b'0123456789abcdef' for c in nonce):
                    conn.sendall(hmac.new(relay.token, nonce, hashlib.sha256).hexdigest().encode('ascii') + b'\n')
            return
        conn.settimeout(None)
        upstream_port = os.environ.get('TMUX_WSL_PROXY_UPSTREAM_PORT', '7890')
        proc = subprocess.Popen([NODE, client_path, upstream_port], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                bufsize=0, close_fds=True)

        def upload():
            try:
                while True:
                    data = conn.recv(65536)
                    if not data:
                        break
                    view = memoryview(data)
                    while view:
                        view = view[os.write(proc.stdin.fileno(), view):]
            except (OSError, ValueError):
                pass
            finally:
                try:
                    proc.stdin.close()
                except OSError:
                    pass

        threading.Thread(target=upload, daemon=True).start()
        while True:
            data = os.read(proc.stdout.fileno(), 65536)
            if not data:
                break
            conn.sendall(data)
    except (OSError, ValueError):
        pass
    finally:
        try:
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        conn.close()
        if proc is not None:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
            if proc.stdout:
                proc.stdout.close()


def serve(port, state):
    relay.token = load_token(state)
    client_path = subprocess.check_output(['wslpath', '-w', str(CLIENT)], text=True).strip()
    slots = threading.BoundedSemaphore(64)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((HOST, port))
        listener.listen(64)
        while True:
            conn, _ = listener.accept()
            if not slots.acquire(blocking=False):
                conn.close()
                continue
            def handle(c=conn):
                try:
                    relay(c, client_path)
                finally:
                    slots.release()
            threading.Thread(target=handle, daemon=True).start()


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--ensure', action='store_true')
    mode.add_argument('--serve', action='store_true')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/tmux-hub/wsl-proxy')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('invalid port')
    try:
        if args.ensure:
            ensure(args.port, args.state_dir)
        else:
            serve(args.port, args.state_dir)
    except (RuntimeError, OSError, subprocess.SubprocessError) as exc:
        print('WSL proxy bridge: ' + str(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
