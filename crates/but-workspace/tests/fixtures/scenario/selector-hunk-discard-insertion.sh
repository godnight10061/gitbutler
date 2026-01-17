#!/usr/bin/env bash

### Description
# A single file with two adjacent added lines, used to exercise selector-hunk discarding (`-0,0 +N,M`).
set -eu -o pipefail

git init

cat <<'EOF' >file
base-1
base-2
base-3
EOF
git add file && git commit -m "init"

cat <<'EOF' >file
base-1
base-2
base-3
line-b
line-a
EOF

