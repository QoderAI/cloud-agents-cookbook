# SPDX-License-Identifier: Apache-2.0

import inspect
import unittest

import app


class InventoryMigrationTest(unittest.IsolatedAsyncioTestCase):
    async def test_public_api_becomes_async_and_uses_result_object(self):
        self.assertIn("modern_sdk", inspect.getsource(app))
        self.assertTrue(inspect.iscoroutinefunction(app.available))
        self.assertEqual(await app.available("SKU-42"), 11)


if __name__ == "__main__":
    unittest.main()
