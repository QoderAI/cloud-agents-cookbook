#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

from pathlib import Path


review = Path(__file__).with_name("manual-review.md")
if not review.exists():
    raise SystemExit("manual-review.md is missing")

text = review.read_text(encoding="utf-8")
required = ("status: blocked", "decision: rounding_mode", "half_even", "half_up")
missing = [value for value in required if value not in text]
if missing:
    raise SystemExit("manual-review.md is missing required evidence: " + ", ".join(missing))

print("manual review package is complete")
