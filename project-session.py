"""Project/session operations. User text is never evaluated by a shell."""
import base64
import json
import os
import subprocess
import sys

spec = json.loads(base64.b64decode(sys.argv[1]))

def tmux(*args, check=True):
    result = subprocess.run(['tmux', *args], capture_output=True, timeout=10)
    if check and result.returncode:
        raise ValueError(result.stderr.decode('utf-8', 'replace').strip() or 'tmux 操作失败')
    return result

def listing():
    result = tmux('list-sessions', '-F', '#{session_name}\t#{session_windows}\t#{session_activity}', check=False)
    if result.returncode:
        error = result.stderr.decode('utf-8', 'replace')
        if 'no server running' in error or 'No such file' in error:
            return []
        raise ValueError(error.strip())
    items = []
    for line in result.stdout.decode('utf-8').splitlines():
        name, windows, activity = line.rsplit('\t', 2)
        if name.startswith('tmux-gui-'):
            continue
        path = tmux('display-message', '-p', '-t', '='+name+':', '#{pane_current_path}', check=False).stdout.decode('utf-8', 'replace').strip()
        items.append(dict(name=name, windows=int(windows), activity=int(activity), path=path))
    return sorted(items, key=lambda item: item['activity'], reverse=True)

try:
    action = spec['action']
    if action == 'validate-path':
        path = os.path.expanduser(spec.get('path') or '')
        if not os.path.isabs(path) or not os.path.isdir(path):
            raise ValueError('项目目录不存在，请填写服务器上的完整目录')
        if not os.access(path, os.R_OK | os.X_OK):
            raise ValueError('没有读取或进入该目录的权限')
        print(json.dumps(dict(path=os.path.normpath(path))))
        sys.exit(0)
    if action == 'list':
        print(json.dumps(listing(), ensure_ascii=True))
        sys.exit(0)
    name = spec.get('sessionName')
    if not name:
        existing = listing()
        preferred = spec.get('preferred', 'work')
        name = next((item['name'] for item in existing if item['name'] == preferred), existing[0]['name'] if existing else preferred)
    if not isinstance(name, str) or not name or any(c in name for c in '\x00\r\n:.'):
        raise ValueError('会话名称无效')
    exists = tmux('has-session', '-t', '='+name, check=False).returncode == 0
    if not exists:
        if spec.get('mode') == 'attach':
            raise ValueError('这个会话已经结束，请重新选择已有会话')
        path = os.path.expanduser(spec.get('path') or '~')
        if not os.path.isabs(path) or not os.path.isdir(path):
            raise ValueError('项目目录不存在，请填写服务器上的完整目录')
        created = tmux('new-session', '-d', '-s', name, '-c', path, check=False)
        if created.returncode and tmux('has-session', '-t', '='+name, check=False).returncode:
            raise ValueError(created.stderr.decode('utf-8', 'replace').strip())
    if action == 'attach':
        os.execvp('tmux', ['tmux', 'attach-session', '-t', '='+name])
    path = tmux('display-message', '-p', '-t', '='+name+':', '#{pane_current_path}').stdout.decode('utf-8', 'replace').strip()
    print(json.dumps(dict(sessionName=name, path=path), ensure_ascii=True))
except (ValueError, OSError, subprocess.SubprocessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
