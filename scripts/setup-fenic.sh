#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -m venv "$repo_dir/.venv-fenic"
"$repo_dir/.venv-fenic/bin/pip" install --upgrade pip
"$repo_dir/.venv-fenic/bin/pip" install -r "$repo_dir/requirements-fenic.txt"
"$repo_dir/.venv-fenic/bin/python" -c 'import fenic; print("fenic runtime ready")'
