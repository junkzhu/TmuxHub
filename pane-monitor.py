"""Read-only geometry for one attached tmux client; EOF ends the monitor."""
import json
import select
import subprocess
import sys
import time

tty = sys.argv[1]

def tmux(*args):
    return subprocess.check_output(['tmux', *args], timeout=3).decode('utf-8', 'replace').strip()

previous = None
while True:
    if select.select([sys.stdin], [], [], 0)[0]:
        if not sys.stdin.buffer.read1(4096):
            break
    try:
        clients = tmux('list-clients', '-F', '#{client_tty}\t#{session_id}\t#{window_id}\t#{pid}\t#{client_width}\t#{client_height}')
        client = next((line.split('\t') for line in clients.splitlines() if line.split('\t')[0] == tty), None)
        if client:
            _, session, window, server, cols, rows = client
            target = session + ':' + window
            fmt = '#{pane_id}\t#{pane_index}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{window_zoomed_flag}\t#{window_width}\t#{window_height}\t#{pane_current_command}'
            panes = []
            for line in tmux('list-panes', '-t', target, '-F', fmt).splitlines():
                parts = line.split('\t', 10)
                if len(parts) != 11:
                    continue
                pane, index, x, y, width, height, active, zoomed, ww, wh, command = parts
                if zoomed == '1' and active != '1':
                    continue
                panes.append(dict(id=pane, index=int(index), x=int(x), y=int(y), width=int(width), height=int(height), active=active == '1', command=command))
            position = tmux('display-message', '-p', '-t', target, '#{status-position}')
            # The desktop config uses a single bottom status row. Other positions
            # fall back to the ordinary terminal rather than guessing offsets.
            result = dict(server=server, session=session, window=window, cols=int(cols), rows=int(rows), panes=panes, supported=position == 'bottom')
            encoded = json.dumps(result, ensure_ascii=True)
            if encoded != previous:
                print(encoded, flush=True)
                previous = encoded
    except (subprocess.SubprocessError, OSError, ValueError, StopIteration):
        pass
    # Waiting on stdin also makes shutdown immediate instead of leaving SSH jobs.
    select.select([sys.stdin], [], [], .5)
