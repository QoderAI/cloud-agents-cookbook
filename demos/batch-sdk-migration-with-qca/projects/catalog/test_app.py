# SPDX-License-Identifier: Apache-2.0

import inspect
import unittest

import app


class CatalogMigrationTest(unittest.TestCase):
    def test_uses_modern_sdk_and_formats_money(self):
        self.assertIn("modern_sdk", inspect.getsource(app))
        self.assertNotIn("legacy_sdk", inspect.getsource(app))
        self.assertEqual(app.display_price("SKU-42"), "SKU-42:CNY 25.99")


if __name__ == "__main__":
    unittest.main()
