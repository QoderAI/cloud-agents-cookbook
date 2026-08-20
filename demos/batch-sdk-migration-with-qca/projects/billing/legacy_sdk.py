# SPDX-License-Identifier: Apache-2.0

from decimal import Decimal, ROUND_HALF_UP


def calculate_total(amount):
    return Decimal(amount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
