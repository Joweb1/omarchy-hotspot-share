#!/usr/bin/env bash
# Helper used by the Hotspot Share bar widget. Runs entirely from the plugin
# directory: no systemd units, no files outside the plugin and XDG dirs.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${HOTSPOT_SHARE_HTTP_PORT:-8080}"
BASE="http://127.0.0.1:${PORT}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/hotspot-share"
PIDFILE="$DATA/server.pid"
LOG="$DATA/server.log"
PAUSED="$DATA/paused"

cmd="${1:-}"
shift || true
uri() { printf '%s' "$1" | jq -sRr @uri; }

node_bin() {
    if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
    if command -v nodejs >/dev/null 2>&1; then command -v nodejs; return 0; fi
    local p
    for p in "$HOME/.local/share/mise/shims/node" /usr/bin/node /usr/local/bin/node; do
        if [ -x "$p" ]; then printf '%s\n' "$p"; return 0; fi
    done
    return 1
}

alive() { curl -fsS --max-time 1 "$BASE/api/ping" >/dev/null 2>&1; }

start() {
    mkdir -p "$DATA"
    rm -f "$PAUSED"
    if alive; then return 0; fi
    local node
    node="$(node_bin)" || { echo "hotspot-share: node is not installed" >&2; exit 1; }
    setsid nohup "$node" "$DIR/server.js" >>"$LOG" 2>&1 &
    printf '%s\n' "$!" >"$PIDFILE"
    local i
    for i in $(seq 1 50); do
        if alive; then return 0; fi
        sleep 0.1
    done
    echo "hotspot-share: server failed to start (see $LOG)" >&2
    exit 1
}

stop() {
    mkdir -p "$DATA"
    if [ -f "$PIDFILE" ]; then
        kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || true
        rm -f "$PIDFILE"
    fi
    pkill -f -- "$DIR/server.js" 2>/dev/null || true
}

case "$cmd" in
    state)
        curl -fsS --max-time 2 "$BASE/api/state?id=shell"
        ;;
    start)
        start
        ;;
    stop)
        : >"$PAUSED"
        stop
        ;;
    halt)
        stop
        ;;
    firewall)
        pkexec bash -c 'for n in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16; do
            for p in 8080 8443; do
                ufw allow proto tcp from "$n" to any port "$p" comment "Hotspot Share"
            done
            ufw allow proto udp from "$n" to any port 5353 comment "Hotspot Share mDNS"
        done
        ufw reload' >/dev/null
        ;;
    accept)
        curl -fsS --max-time 5 -X POST -H 'Content-Type: application/json' \
            --data '{"accept":true}' "$BASE/api/offer/$1/decision" >/dev/null
        ;;
    decline)
        curl -fsS --max-time 5 -X POST -H 'Content-Type: application/json' \
            --data '{"accept":false}' "$BASE/api/offer/$1/decision" >/dev/null
        ;;
    delete-send)
        curl -fsS --max-time 5 -X DELETE "$BASE/api/send/$(uri "$1")" >/dev/null
        ;;
    delete-recv)
        curl -fsS --max-time 5 -X DELETE "$BASE/api/received/$(uri "$1")" >/dev/null
        ;;
    open-send)
        xdg-open "$HOME/Hotspot Share/send" >/dev/null 2>&1 || true
        ;;
    open-received)
        xdg-open "$HOME/Hotspot Share/received" >/dev/null 2>&1 || true
        ;;
    copy)
        printf '%s' "$1" | wl-copy
        ;;
    *)
        echo "usage: hs state|start|stop|halt|firewall|accept ID|decline ID|delete-send NAME|delete-recv NAME|open-send|open-received|copy TEXT" >&2
        exit 64
        ;;
esac
