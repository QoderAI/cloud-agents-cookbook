# SPDX-License-Identifier: Apache-2.0

import json
import unittest
from pathlib import Path

from check_baseline import ROOT, check_baseline


class FixtureContractTests(unittest.TestCase):
    def test_tasks_have_isolated_existing_projects_and_commands(self):
        tasks = json.loads((ROOT / "tasks.json").read_text(encoding="utf-8"))["tasks"]
        self.assertEqual(len(tasks), 4)
        self.assertEqual(len({task["custom_id"] for task in tasks}), 4)
        self.assertEqual(len({task["project_path"] for task in tasks}), 4)
        for task in tasks:
            project = ROOT / task["project_path"]
            self.assertTrue(project.is_dir(), project)
            self.assertIn(task["project_path"], task["acceptance_command"])
            self.assertIn(task["outcome"], {"automated", "manual-review"})

    def test_every_task_starts_with_the_documented_failure_evidence(self):
        results = check_baseline()
        self.assertEqual([item["custom_id"] for item in results], [
            "migrate-catalog",
            "migrate-orders",
            "migrate-inventory",
            "migrate-billing",
        ])
        self.assertTrue(all(item["state"] == "ready" for item in results))


if __name__ == "__main__":
    unittest.main()
