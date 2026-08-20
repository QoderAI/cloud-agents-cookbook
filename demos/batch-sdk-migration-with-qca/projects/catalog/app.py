# SPDX-License-Identifier: Apache-2.0

from legacy_sdk import Client


def display_price(sku):
    product = Client().fetch(sku)
    return f"{product['sku']}:{product['price_cents'] / 100:.2f}"
