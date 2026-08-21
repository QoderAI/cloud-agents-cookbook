# SPDX-License-Identifier: Apache-2.0


class LegacyOrderError(Exception):
    pass


class LegacyOrderClient:
    def submit(self, payload):
        if not payload.get("items"):
            raise LegacyOrderError("empty order")
        return {"id": "ord-legacy", "status": "created"}
