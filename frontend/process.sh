#!/usr/bin/env bash
# Shared by start.sh and stop.sh after changing into the frontend directory.
frontend_dir=$(pwd -P)
OWNER_FILE=.frontend.owner

process_start() {
  ps -p "$1" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//'
}

is_ours() {
  case "${1:-}" in ''|*[!0-9]*|0) return 1 ;; esac
  local process_command process_cwd recorded_pid recorded_start current_start

  # start.sh records the wrapper PID and process start time. This survives
  # platforms where cwd inspection is unavailable and protects against PID
  # reuse after a stale marker is left behind. Some macOS sandbox contexts
  # hide the command line from ps, so the marker is checked before that probe.
  if [ -f "$OWNER_FILE" ]; then
    IFS=' ' read -r recorded_pid recorded_start < "$OWNER_FILE" || return 1
    [ "$recorded_pid" = "$1" ] || return 1
    if [ -n "$recorded_start" ]; then
      current_start=$(process_start "$1") || current_start=''
      [ "$current_start" = "$recorded_start" ] || return 1
    fi
    if [ -d "/proc/$1" ]; then
      process_cwd=$(readlink "/proc/$1/cwd" 2>/dev/null) || return 1
    else
      process_cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    fi
    [ "$process_cwd" = "$frontend_dir" ] || return 1
    return 0
  fi

  process_command=$(ps -p "$1" -o command= 2>/dev/null) || return 1
  case "$process_command" in *vite/bin/vite.js*) ;; *) return 1 ;; esac

  # A Vite command alone could belong to any project after PID reuse.
  # Linux exposes cwd in /proc; macOS exposes it through lsof. If it cannot
  # be verified, leave the process alone.
  if [ -d "/proc/$1" ]; then
    process_cwd=$(readlink "/proc/$1/cwd" 2>/dev/null) || return 1
  else
    process_cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  fi
  [ "$process_cwd" = "$frontend_dir" ]
}
