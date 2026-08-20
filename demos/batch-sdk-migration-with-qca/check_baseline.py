#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Verify that every synthetic task starts in its intended unresolved state."""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def check_baseline() -> list[dict]:
    tasks = json.loads((ROOT / "tasks.json").read_text(encoding="utf-8"))["tasks"]
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    results = []
    for task in tasks:
        process = subprocess.run(
            shlex.split(task["acceptance_command"]),
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        output = process.stdout + process.stderr
        expected = task["baseline_error"]
        if process.returncode == 0:
            raise RuntimeError(f"{task['custom_id']} unexpectedly passes before migration")
        if expected not in output:
            raise RuntimeError(f"{task['custom_id']} failed without expected evidence {expected!r}")
        results.append({"custom_id": task["custom_id"], "state": "ready", "evidence": expected})
    return results


def main() -> int:
    try:
        for result in check_baseline():
            print(f"{result['custom_id']}: {result['state']} ({result['evidence']})")
        return 0
    except RuntimeError as exc:
        print(f"baseline contract failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
