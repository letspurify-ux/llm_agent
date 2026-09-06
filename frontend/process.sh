#!/usr/bin/env bash
# Shared by start.sh and stop.sh after changing into the frontend directory.
frontend_dir=$(pwd -P)

is_ours() {
  case "${1:-}" in ''|*[!0-9]*|0) return 1 ;; esac
  local process_command process_cwd
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
