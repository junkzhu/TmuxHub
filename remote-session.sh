#!/bin/sh
if ! command -v tmux >/dev/null 2>&1; then
    printf 'tmux is not installed on this server.\n'
    if [ "${1-}" = '--configure-only' ]; then exit 1; fi
    exec "$SHELL" -l
fi
mkdir -p "$HOME/.config/tmux"
if [ "${1-}" != '--configure-only' ]; then
cat > "$HOME/.config/tmux/tmux-directional.conf" <<'TMUX_KEYS'
# Directional splits shared with the Tmux desktop application.
bind-key -n C-Left split-window -h -b -c "#{pane_current_path}"
bind-key -n C-Right split-window -h -c "#{pane_current_path}"
bind-key -n C-Up split-window -v -b -c "#{pane_current_path}"
bind-key -n C-Down split-window -v -c "#{pane_current_path}"
set -g mouse on
# Desktop context-menu actions, handled by tmux even inside a full-screen app.
set-option -s user-keys[90] "\033[9001~"
set-option -s user-keys[91] "\033[9002~"
set-option -s user-keys[92] "\033[9003~"
set-option -s user-keys[93] "\033[9004~"
set-option -s user-keys[94] "\033[9005~"
bind-key -n User90 new-window -c "#{pane_current_path}"
bind-key -n User91 split-window -h -c "#{pane_current_path}"
bind-key -n User92 split-window -h -b -c "#{pane_current_path}"
bind-key -n User93 split-window -v -c "#{pane_current_path}"
bind-key -n User94 split-window -v -b -c "#{pane_current_path}"
TMUX_KEYS
if ! grep -Fq 'source-file ~/.config/tmux/tmux-directional.conf' "$HOME/.tmux.conf" 2>/dev/null; then
    if [ -f "$HOME/.tmux.conf" ]; then
        cp -p "$HOME/.tmux.conf" "$HOME/.tmux.conf.before-directional-splits"
    fi
    printf '\n# Tmux desktop directional splits\nsource-file ~/.config/tmux/tmux-directional.conf\n' >> "$HOME/.tmux.conf"
fi
fi

# Keep the desktop's pane hierarchy available on every SSH connection.
# A separate source file makes the appearance easy to remove or adjust later.
appearance="$HOME/.config/tmux/tmux-desktop-appearance.conf"
appearance_tmp=$(mktemp "$HOME/.config/tmux/.appearance.XXXXXX") || exit 1
cat > "$appearance_tmp" <<'TMUX_APPEARANCE'
# Tmux desktop: warm charcoal panes, restrained blue/violet focus.
# Tc also works with tmux 3.0a, unlike the newer terminal-features option.
if-shell 'tmux show-options -sv terminal-overrides | grep -Fq "xterm-256color:Tc"' '' 'set-option -as terminal-overrides ",xterm-256color:Tc"'
set-option -g window-style 'fg=#E5E2DC,bg=#1D1E1C'
set-option -g window-active-style 'fg=#F2F0EB,bg=#242522'
set-option -g pane-border-style 'fg=#4A4B46,bg=#1D1E1C'
set-option -g pane-active-border-style 'fg=#9485D6,bg=#242522'
set-option -g pane-border-status top
set-option -g pane-border-format '#[fg=#{?pane_active,#FAF8F3,#C9C6C0},bg=#{?pane_active,#393452,#292A27}] #{?pane_active,● ,}#{pane_index} · #{pane_current_command} #[fg=#{?pane_active,#B2BFE7,#9D9E98}]#{=24:pane_current_path} #[default]'
set-option -g status-style 'fg=#AAA9A3,bg=#292A27'
set-option -g status-left '#[fg=#C9C6C0,bg=#363634] #S #[default] '
set-option -g status-left-length 24
set-option -g status-right '#[fg=#AAA9A3] #h #[fg=#858680] %H:%M '
set-option -g status-right-length 40
set-option -g window-status-style 'fg=#AAA9A3,bg=#292A27'
set-option -g window-status-current-style 'fg=#F2F0EB,bg=#4B4389,bold'
set-option -g window-status-format ' #I · #W '
set-option -g window-status-current-format ' #I · #W '
set-option -g window-status-separator ' '
set-option -g window-status-activity-style 'fg=#B2BFE7,bg=#292A27'
set-option -g window-status-bell-style 'fg=#E5B660,bg=#292A27'
set-option -g message-style 'fg=#E5E2DC,bg=#393452'
set-option -g message-command-style 'fg=#E5E2DC,bg=#393452'
set-option -g mode-style 'fg=#F2F0EB,bg=#4B4389'
TMUX_APPEARANCE
if [ -f "$appearance" ] && ! cmp -s "$appearance_tmp" "$appearance"; then
    if [ ! -e "$appearance.before-desktop-appearance" ]; then
        cp -p "$appearance" "$appearance.before-desktop-appearance"
    fi
fi
mv "$appearance_tmp" "$appearance"
if ! grep -Fq 'source-file ~/.config/tmux/tmux-desktop-appearance.conf' "$HOME/.tmux.conf" 2>/dev/null; then
    if [ -f "$HOME/.tmux.conf" ] && [ ! -e "$HOME/.tmux.conf.before-desktop-appearance" ]; then
        cp -p "$HOME/.tmux.conf" "$HOME/.tmux.conf.before-desktop-appearance"
    fi
    printf '\n# Tmux desktop pane appearance\nsource-file ~/.config/tmux/tmux-desktop-appearance.conf\n' >> "$HOME/.tmux.conf"
fi

if [ "${1-}" != '--configure-only' ]; then
    printf '\033]777;tmux-client;%s\007' "$(tty)"
fi
if tmux list-sessions >/dev/null 2>&1; then
    if [ "${1-}" != '--configure-only' ]; then
        tmux source-file "$HOME/.config/tmux/tmux-directional.conf"
    fi
    tmux source-file "$appearance"
    # Existing per-pane, per-window or per-session options otherwise shadow
    # the new defaults. Only these appearance options are reset to inherit.
    tmux list-panes -a -F '#{pane_id}' | while IFS= read -r pane; do
        tmux set-option -pu -t "$pane" window-style
        tmux set-option -pu -t "$pane" window-active-style
    done
    tmux list-windows -a -F '#{window_id}' | sort -u | while IFS= read -r window; do
        for option in window-style window-active-style pane-border-style pane-active-border-style pane-border-status pane-border-format window-status-style window-status-current-style window-status-format window-status-current-format window-status-separator window-status-activity-style window-status-bell-style mode-style; do
            tmux set-option -wu -t "$window" "$option"
        done
    done
    tmux list-sessions -F '#{session_id}' | while IFS= read -r session; do
        for option in status-style status-left status-left-length status-right status-right-length message-style message-command-style; do
            tmux set-option -u -t "$session" "$option"
        done
    done
    if [ "${1-}" = '--configure-only' ]; then exit 0; fi
    exec tmux attach-session
else
    if [ "${1-}" = '--configure-only' ]; then exit 0; fi
    exec tmux new-session -s work
fi
