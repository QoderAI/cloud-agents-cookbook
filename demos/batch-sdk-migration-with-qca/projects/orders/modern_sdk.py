# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass


class RequestError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class OrderResult:
    order_id: str
    status: str
    idempotency_key: str


class ModernOrderClient:
    def create_order(self, *, line_items, idempotency_key):
        if not line_items:
            raise RequestError("empty_order")
        return OrderResult("ord-modern", "created", idempotency_key)
