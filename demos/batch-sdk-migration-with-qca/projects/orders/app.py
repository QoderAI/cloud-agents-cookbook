# SPDX-License-Identifier: Apache-2.0

from legacy_sdk import LegacyOrderClient, LegacyOrderError


class OrderGateway:
    def __init__(self):
        self.client = LegacyOrderClient()

    def place(self, items, request_id):
        try:
            result = self.client.submit({"items": items})
        except LegacyOrderError:
            return "rejected:legacy_error"
        return f"{result['id']}:{request_id}"
