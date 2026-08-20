# SPDX-License-Identifier: Apache-2.0

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Money:
    currency: str
    amount: Decimal


@dataclass(frozen=True)
class Product:
    sku: str
    price: Money


class Client:
    def __init__(self, *, region):
        if region != "CN":
            raise ValueError("Workshop fixture supports only the CN region")

    def get_product(self, *, product_id):
        return Product(product_id, Money("CNY", Decimal("25.99")))
