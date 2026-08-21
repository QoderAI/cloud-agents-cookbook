# SPDX-License-Identifier: Apache-2.0

from legacy_sdk import Client


def available(sku):
    return Client().stock(sku)
