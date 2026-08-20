# SPDX-License-Identifier: Apache-2.0

from decimal import Decimal, ROUND_HALF_EVEN, ROUND_HALF_UP


class Client:
    def __init__(self, *, rounding_mode):
        if rounding_mode not in {"half_even", "half_up"}:
            raise ValueError("rounding_mode must be half_even or half_up")
        self.rounding_mode = rounding_mode

    def calculate_total(self, amount):
        rounding = ROUND_HALF_EVEN if self.rounding_mode == "half_even" else ROUND_HALF_UP
        return Decimal(amount).quantize(Decimal("0.01"), rounding=rounding)
