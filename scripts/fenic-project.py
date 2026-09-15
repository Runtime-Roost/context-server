#!/usr/bin/env python3
"""Project an already-authorized, bounded Context result set with Fenic."""

import contextlib
import json
from pathlib import Path
import sys
import tempfile

import fenic as fc


def main() -> None:
    request = json.load(sys.stdin)
    rows = request.get("rows")
    fields = request.get("select")
    if not isinstance(rows, list) or len(rows) > 50:
        raise ValueError("FENIC_ROWS_INVALID")
    if not isinstance(fields, list) or not fields or len(fields) > 16:
        raise ValueError("FENIC_SELECT_INVALID")
    if not all(isinstance(field, str) for field in fields):
        raise ValueError("FENIC_SELECT_INVALID")
    if not rows:
        print("[]")
        return

    projected_input = [{field: row.get(field) for field in fields} for row in rows]
    null_only_fields = {
        field for field in fields
        if all(row.get(field) is None for row in projected_input)
    }
    for row in projected_input:
        for field in null_only_fields:
            row[field] = "__CONTEXT_FENIC_NULL__"

    # Fenic emits its usage summary on stdout. Keep stdout machine-readable and
    # route all engine diagnostics to stderr instead.
    with tempfile.TemporaryDirectory(prefix="context-server-fenic-") as temporary:
        with contextlib.redirect_stdout(sys.stderr):
            session = fc.Session.get_or_create(fc.SessionConfig(
                app_name="context_server",
                db_path=Path(temporary),
            ))
            try:
                projected = session.create_dataframe(projected_input).select(*fields).to_pylist()
            finally:
                session.stop()
    for row in projected:
        for field in null_only_fields:
            row[field] = None
    print(json.dumps(projected, separators=(",", ":"), ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Keep the bridge error bounded and content-free.
        print(str(error)[:300], file=sys.stderr)
        raise SystemExit(1)
