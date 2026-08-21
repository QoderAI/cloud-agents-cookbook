# SPDX-License-Identifier: Apache-2.0

import inspect
import unittest

import app


class OrdersMigrationTest(unittest.TestCase):
    def test_adapter_maps_result_and_idempotency_key(self):
        self.assertIn("modern_sdk", inspect.getsource(app))
        gateway = app.OrderGateway()
        self.assertEqual(gateway.place([{"sku": "SKU-42", "quantity": 1}], "request-7"), "ord-modern:request-7")

    def test_adapter_maps_new_error_code(self):
        gateway = app.OrderGateway()
        self.assertEqual(gateway.place([], "request-8"), "rejected:empty_order")


if __name__ == "__main__":
    unittest.main()
