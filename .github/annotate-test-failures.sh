#!/usr/bin/env bash
# Runs a test command (its arguments) and, when it fails, reports each failed
# test with its message as an error annotation: a run's logs are readable by
# repository admins only, its annotations by anyone who can read the
# repository. Without a failed test to name (a build error, a crash), the
# output's last lines are reported.
set -o pipefail
log=$(mktemp)
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  awk -v command="$*" '
    function data(s) { gsub(/\r/, "", s); gsub(/%/, "%25", s); return s }
    function property(s) { s = data(s); gsub(/:/, "%3A", s); gsub(/,/, "%2C", s); return s }
    function emit() {
      if (name == "") return
      if (length(message) > 3000) message = substr(message, 1, 3000) "..."
      printf "::error title=%s::%s\n", property(name), message
      found = 1; name = ""; message = ""
    }
    /^---- .* stdout ----$/ { emit(); name = $2; message = ""; next }
    /^failures:$/ { emit(); next }
    /^note: run with `RUST_BACKTRACE/ { next }
    name != "" { line = data($0); message = (message == "" ? line : message "%0A" line) }
    { last[NR % 30] = $0 }
    END {
      emit()
      if (!found) {
        text = ""
        for (i = NR - 29; i <= NR; i++) if (i > 0) text = text (text == "" ? "" : "%0A") data(last[i % 30])
        printf "::error title=%s::%s\n", property(command), text
      }
    }
  ' "$log"
fi
rm -f "$log"
exit "$status"
