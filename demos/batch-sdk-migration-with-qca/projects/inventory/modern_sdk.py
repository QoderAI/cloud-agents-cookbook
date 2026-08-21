# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass


@dataclass(frozen=True)
class InventoryResult:
    sku: str
    available: int


class Client:
    async def get_inventory(self, *, sku):
        return InventoryResult(sku=sku, available=11 if sku else 0)
