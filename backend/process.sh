#!/usr/bin/env bash
# Shared by start.sh and stop.sh after changing into the backend directory.
backend_dir=$(pwd -P)

is_ours() {
  case "${1:-}" in ''|*[!0-9]*|0) return 1 ;; esac
  local process_command process_cwd process_executable
  process_command=$(ps -p "$1" -o command= 2>/dev/null) || return 1
  case "$process_command" in *" src/server.js"|*" src/server.js "*) ;; *) return 1 ;; esac
  process_executable=$(ps -p "$1" -o comm= 2>/dev/null) || return 1
  case "${process_executable##*/}" in node|nodejs) ;; *) return 1 ;; esac
  # A relative server path can belong to any checkout after PID reuse.
  # If its working directory cannot be verified, leave it alone.
  if [ -d "/proc/$1" ]; then
    process_cwd=$(readlink "/proc/$1/cwd" 2>/dev/null) || return 1
  else
    process_cwd=$(lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  fi
  [ "$process_cwd" = "$backend_dir" ]
}
