"""Persistent GUI layout; move existing tmux panes without restarting processes."""
import base64
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import uuid

spec = json.loads(base64.b64decode(sys.argv[1]))

def tm(*args, check=True):
    p = subprocess.run(['tmux', *args], capture_output=True, timeout=10)
    if check and p.returncode:
        raise ValueError(args[0]+': '+p.stderr.decode('utf-8', 'replace').strip())
    return p.stdout.decode('utf-8', 'replace').strip()

def parse_layout(value):
    if value.startswith('{'):
        def convert(node):
            if node['t'] == 'p':
                return dict(pane=node.get('I', '%'+str(node['i'])), width=node['w'], height=node['h'])
            axis = 'x' if node['t'] == 'h' else 'y'
            children = [convert(c) for c in node['c']]
            return dict(axis=axis, children=children, weights=[c['width' if axis == 'x' else 'height'] for c in children], width=node['w'], height=node['h'])
        return convert(json.loads(value)['L'])
    value = value.split(',', 1)[1]
    def parse(pos):
        m = re.match(r'(\d+)x(\d+),(\d+),(\d+)', value[pos:])
        if not m:
            raise ValueError('无法读取现有分屏布局')
        w, h, x, y = map(int, m.groups()); pos += m.end()
        if value[pos] == ',':
            m = re.match(r',(\d+)', value[pos:]); pos += m.end()
            return dict(pane='%'+m[1], width=w, height=h), pos
        opening = value[pos]; closing = '}' if opening == '{' else ']'
        if opening not in '{[':
            raise ValueError('不支持的分屏布局')
        pos += 1; children = []
        while True:
            child, pos = parse(pos); children.append(child)
            if value[pos] == closing:
                pos += 1; break
            if value[pos] != ',':
                raise ValueError('分屏布局无效')
            pos += 1
        axis = 'x' if opening == '{' else 'y'
        weights = [c['width' if axis == 'x' else 'height'] for c in children]
        return dict(axis=axis, children=children, weights=weights, width=w, height=h), pos
    tree, _ = parse(0)
    return tree

def leaves(tree):
    if 'pane' in tree:
        return [tree['pane']]
    return [p for c in tree['children'] for p in leaves(c)]

def replace_leaf(tree, pane, replacement):
    if tree.get('pane') == pane:
        return replacement
    if 'children' in tree:
        tree['children'] = [replace_leaf(c, pane, replacement) for c in tree['children']]
    return tree

def prune_tree(tree, alive):
    if 'pane' in tree:
        return tree if tree['pane'] in alive else None
    pairs = [(prune_tree(c, alive), w) for c, w in zip(tree['children'], tree['weights'])]
    pairs = [(c, w) for c, w in pairs if c is not None]
    if not pairs:
        return None
    if len(pairs) == 1:
        return pairs[0][0]
    return dict(axis=tree['axis'], children=[c for c, w in pairs], weights=[w for c, w in pairs])

def reconcile():
    rows = tm('list-panes', '-a', '-F', '#{pane_id} #{pane_dead}').splitlines()
    live = {row.split()[0] for row in rows if row.endswith(' 0')}
    dead = {row.split()[0] for row in rows if row.endswith(' 1')}
    removed = set(state['panes']) - live
    if not removed:
        return
    for pane in removed:
        del state['panes'][pane]
    groups = []
    for group in state['groups']:
        tree = prune_tree(group['tree'], live)
        if tree:
            group['tree'] = tree
            groups.append(group)
    state['groups'] = groups
    if state.get('focusPane') in removed:
        state.pop('focusPane', None)
    if not any(g['id'] == state.get('activeGroup') for g in groups):
        state['activeGroup'] = groups[0]['id'] if groups else None
    state['revision'] += 1
    save()
    # Only reap panes positively reported dead; never kill a live process.
    for pane in removed & dead:
        tm('kill-pane', '-t', pane, check=False)

def pane_info(pane):
    line = tm('display-message', '-p', '-t', pane, '#{pane_id}\t#{window_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}')
    fields = line.split('\t', 4)
    if len(fields) != 5 or fields[0] != pane:
        raise ValueError('终端进程已经结束')
    return dict(pane=pane, window=fields[1], pid=int(fields[2]), path=fields[3], title=fields[4])

def save():
    tmp = filename+'.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=True)
        f.flush(); os.fsync(f.fileno())
    os.replace(tmp, filename)

def isolate(pane):
    item = state['panes'][pane]
    info = pane_info(pane)
    count = len(tm('list-panes', '-t', info['window'], '-F', '#{pane_id}').splitlines())
    if count > 1:
        tm('break-pane', '-d', '-s', pane, '-t', '='+state['session']+':', '-n', 'terminal-'+pane[1:])
        info = pane_info(pane)
    item.update(info)
    save()  # A retry can resume safely after any individual move.
    owner = '='+state['session']
    if info['window'] not in tm('list-windows', '-t', owner, '-F', '#{window_id}').splitlines():
        tm('link-window', '-s', info['window'], '-t', owner+':')
    session = item['session']
    found = tm('list-sessions', '-F', '#{session_name}', check=False).splitlines()
    if session not in found:
        idx = tm('new-session', '-d', '-s', session, '-x', '120', '-y', '40', '-P', '-F', '#{window_index}', 'sleep 86400')
        tm('set-option', '-t', session, '@tmux_gui_internal', '1')
        # This replaces only the temporary sleep pane we just created.
        tm('link-window', '-k', '-s', info['window'], '-t', '='+session+':'+idx)
    else:
        linked = tm('list-windows', '-t', '='+session, '-F', '#{window_id}').splitlines()
        if info['window'] not in linked:
            tm('link-window', '-s', info['window'], '-t', '='+session+':')
        for other in linked:
            if other != info['window']:
                if other not in tm('list-windows', '-t', owner, '-F', '#{window_id}').splitlines():
                    tm('link-window', '-s', other, '-t', owner+':')
                tm('unlink-window', '-t', '='+session+':'+other)
    tm('select-window', '-t', '='+session+':'+info['window'])
    tm('set-option', '-t', session, 'status', 'off')
    tm('set-option', '-t', session, 'mouse', 'on')
    for option, value in [('pane-border-status', 'off'), ('remain-on-exit', 'off')]:
        tm('set-option', '-w', '-t', info['window'], option, value)
    # Let the GUI terminal palette supply the managed pane's text and background.
    for option in ('window-style', 'window-active-style'):
        tm('set-option', '-pu', '-t', pane, option, check=False)
        tm('set-option', '-w', '-t', info['window'], option, 'fg=default,bg=default')
    tm('set-option', '-w', '-t', info['window'], 'mode-style', 'fg=#242629,bg=#DDE8F6')
    try:
        tm('set-option', '-w', '-t', info['window'], 'window-size', 'latest')
    except ValueError:
        tm('set-option', '-w', '-t', info['window'], 'window-size', 'smallest')

def validate_tree(tree, depth=0):
    if depth > 30 or not isinstance(tree, dict):
        raise ValueError('布局无效')
    if 'pane' in tree:
        if tree['pane'] not in state['panes']:
            raise ValueError('终端不存在')
        return {'pane': tree['pane']}
    children, weights = tree.get('children'), tree.get('weights')
    if tree.get('axis') not in ['x', 'y'] or not isinstance(children, list) or not 2 <= len(children) <= 100 or not isinstance(weights, list) or len(weights) != len(children):
        raise ValueError('布局无效')
    if any(not isinstance(w, (int, float)) or not 0 < w <= 100000 for w in weights):
        raise ValueError('分屏比例无效')
    return dict(axis=tree['axis'], weights=weights, children=[validate_tree(c, depth+1) for c in children])

try:
    session = spec['sessionName']
    if not isinstance(session, str) or not session or any(c in session for c in '\x00\r\n:.'):
        raise ValueError('会话名称无效')
    directory = os.path.expanduser('~/.local/state/tmux-gui')
    os.makedirs(directory, mode=0o700, exist_ok=True)
    filename = os.path.join(directory, hashlib.sha256(session.encode()).hexdigest()+'.json')
    lock = open(filename+'.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = None
    if os.path.exists(filename):
        with open(filename, encoding='utf-8') as f:
            state = json.load(f)
    exists = subprocess.run(['tmux', 'has-session', '-t', '='+session], capture_output=True, timeout=10).returncode == 0
    if not exists and spec['action'] == 'prepare':
        if spec.get('inspectOnly') and state:
            state.update(groups=[], panes={}, activeGroup=None, revision=state['revision']+1)
            save()
            print(json.dumps(state))
            sys.exit(0)
        previous_path = os.path.expanduser(spec.get('path') or next(iter((state or {}).get('panes', {}).values()), {}).get('path', '~'))
        if spec.get('path') and not os.path.isdir(previous_path):
            raise ValueError('项目目录不存在，请右键编辑项目路径')
        if not os.path.isdir(previous_path):
            previous_path = os.path.expanduser('~')
        tm('new-session', '-d', '-s', session, '-c', previous_path)
        state = None
    server = tm('display-message', '-p', '-t', '='+session+':', '#{pid}')
    if not server.isdigit():
        raise ValueError('项目会话不存在')
    if state:
        if state.get('server') != server:
            os.rename(filename, filename+'.previous-'+str(int(time.time())))
            state = None
    action = spec['action']
    if not state:
        if action != 'prepare':
            raise ValueError('请先打开项目')
        raw = tm('list-windows', '-t', '='+session, '-F', '#{window_id}\t#{window_name}\t#{window_layout}\t#{window_active}')
        state = dict(version=1, server=server, session=session, groups=[], panes={}, ready=False, revision=0)
        for line in raw.splitlines():
            wid, name, layout, active = line.split('\t', 3)
            tree = parse_layout(layout)
            state['groups'].append(dict(id=wid, name=name, tree=tree, originalLayout=layout))
            if active == '1':
                state['activeGroup'] = wid
            for pane in leaves(tree):
                state['panes'][pane] = dict(**pane_info(pane), session='tmux-gui-'+uuid.uuid4().hex[:20])
        save()
        with open(filename+'.before-migration-'+server, 'w', encoding='utf-8') as f:
            json.dump(state, f)
    if action == 'prepare':
        migrating = not state.get('ready')
        reconcile()
        for pane in state['panes']:
            isolate(pane)
        state['ready'] = True
        if migrating:
            # Detach only the old shared-grid clients. The shells and all
            # dedicated pane sessions remain alive throughout the migration.
            tm('detach-client', '-s', session, check=False)
    elif action == 'split':
        pane = spec['pane']; direction = spec['direction']
        if pane not in state['panes'] or direction not in ['left', 'right', 'up', 'down', 'window']:
            raise ValueError('新建终端请求无效')
        path = pane_info(pane)['path']
        configured = os.path.expanduser(spec.get('path') or '~')
        if spec.get('pathOverride') and not (path == configured or path.startswith(configured.rstrip('/')+'/')):
            path = configured
        if not os.path.isdir(path):
            path = configured
        if not os.path.isdir(path):
            raise ValueError('项目目录不存在，请右键编辑项目路径')
        newpane = tm('new-window', '-d', '-t', '='+session+':', '-c', path, '-P', '-F', '#{pane_id}')
        state['panes'][newpane] = dict(**pane_info(newpane), session='tmux-gui-'+uuid.uuid4().hex[:20])
        if direction == 'window':
            group = dict(id='group-'+uuid.uuid4().hex[:12], name='终端', tree=dict(pane=newpane))
            state['groups'].append(group); state['activeGroup'] = group['id']
        else:
            children = [dict(pane=pane), dict(pane=newpane)]
            if direction in ['left', 'up']:
                children.reverse()
            replacement = dict(axis='x' if direction in ['left', 'right'] else 'y', weights=[1, 1], children=children)
            for group in state['groups']:
                if pane in leaves(group['tree']):
                    group['tree'] = replace_leaf(group['tree'], pane, replacement)
                    state['activeGroup'] = group['id']; break
        state['revision'] += 1; save(); isolate(newpane)
        state['focusPane'] = newpane
    elif action == 'layout':
        group = next((g for g in state['groups'] if g['id'] == spec.get('group')), None)
        if not group or spec.get('revision') != state['revision']:
            raise ValueError('布局已在其他窗口更新，请重试')
        tree = validate_tree(spec['tree'])
        if sorted(leaves(tree)) != sorted(leaves(group['tree'])):
            raise ValueError('布局不能移除已有终端')
        group['tree'] = tree; state['revision'] += 1
    elif action == 'attach':
        pane = spec['pane']
        if pane not in state['panes']:
            raise ValueError('终端不存在')
        isolate(pane)
        fcntl.flock(lock, fcntl.LOCK_UN); lock.close()
        os.execvp('tmux', ['tmux', 'attach-session', '-t', '='+state['panes'][pane]['session']])
    else:
        raise ValueError('未知操作')
    save()
    print(json.dumps(state, ensure_ascii=True))
except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)
