#!/usr/bin/env python3
"""JSON-lines bridge between a local websocket and a real Unix PTY."""
import os, sys, pty, select, json, base64, fcntl, termios, struct, signal

pid, master = pty.fork()
if pid == 0:
    os.environ['TERM'] = 'xterm-256color'
    os.environ['COLORTERM'] = 'truecolor'
    shell = os.environ.get('SHELL', '/bin/zsh')
    os.execv(shell, [shell, '-i'])

def finish(*_):
    try: os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError: pass
    try: os.close(master)
    except OSError: pass
    sys.exit(0)

signal.signal(signal.SIGTERM, finish)
buffer = b''
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [])
        if master in ready:
            try: data = os.read(master, 16384)
            except OSError: break
            if not data: break
            print(json.dumps({'type': 'data', 'data': base64.b64encode(data).decode()}), flush=True)
        if sys.stdin.buffer in ready:
            data = os.read(sys.stdin.fileno(), 16384)
            if not data: break
            buffer += data
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                try:
                    message = json.loads(line)
                    if message['type'] == 'input': os.write(master, message['data'].encode())
                    elif message['type'] == 'resize':
                        rows = min(500, max(2, int(message['rows'])))
                        cols = min(500, max(2, int(message['cols'])))
                        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                except (ValueError, KeyError, TypeError): pass
finally:
    finish()
