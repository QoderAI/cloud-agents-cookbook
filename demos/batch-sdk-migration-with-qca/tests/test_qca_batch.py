# SPDX-License-Identifier: Apache-2.0

import json
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from qca_batch import (
    QoderBatchClient,
    build_batch_lines,
    build_retry_lines,
    merge_result_rows,
    read_jsonl,
    write_jsonl,
)


TASKS = [
    {
        "custom_id": "migrate-catalog",
        "project_path": "projects/catalog",
        "acceptance_command": "python3 -B -m unittest discover -s projects/catalog -p 'test_*.py' -v",
        "outcome": "automated",
    },
    {
        "custom_id": "migrate-billing",
        "project_path": "projects/billing",
        "acceptance_command": "python3 -B projects/billing/check_manual_review.py",
        "outcome": "manual-review",
    },
]


class BatchLineTests(unittest.TestCase):
    def test_build_lines_can_inject_one_validation_error(self):
        lines = build_batch_lines(
            TASKS,
            template_id="tmpl_example",
            identity_id="idn_example",
            inject_invalid="migrate-billing",
        )

        self.assertEqual([line["custom_id"] for line in lines], ["migrate-catalog", "migrate-billing"])
        self.assertEqual(lines[0]["identity_id"], "idn_example")
        self.assertNotIn("identity_id", lines[1])
        self.assertIn("projects/catalog", lines[0]["body"]["input"])
        self.assertIn("/workspace/cloud-agents-cookbook", lines[0]["body"]["input"])
        self.assertIn("cd /workspace/cloud-agents-cookbook/demos/batch-sdk-migration-with-qca && python3", lines[0]["body"]["input"])
        self.assertIn("git diff --binary", lines[0]["body"]["input"])
        self.assertIn("projects/billing/manual-review.md", lines[1]["body"]["input"])
        self.assertNotIn("replace_with", json.dumps(lines))

    def test_retry_rebuilds_only_failed_custom_ids(self):
        errors = [
            {
                "custom_id": "migrate-billing",
                "status": "failed",
                "error": {"code": "invalid_request", "message": "identity_id is required"},
            }
        ]

        lines = build_retry_lines(TASKS, errors, "tmpl_example", "idn_example")

        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["custom_id"], "migrate-billing")
        self.assertEqual(lines[0]["identity_id"], "idn_example")

    def test_jsonl_round_trip_preserves_unicode(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.jsonl"
            write_jsonl(path, [{"custom_id": "任务-1", "body": {"input": "升级服务"}}])

            self.assertEqual(read_jsonl(path)[0]["body"]["input"], "升级服务")

    def test_result_summary_deduplicates_failed_rows(self):
        output = [
            {"custom_id": "migrate-catalog", "status": "completed"},
            {
                "custom_id": "migrate-billing",
                "status": "failed",
                "error": {"code": "generic"},
                "usage": {"total_credits": 1.25},
            },
        ]
        errors = [
            {"custom_id": "migrate-billing", "status": "failed", "error": {"code": "invalid_request"}}
        ]

        rows = merge_result_rows(output, errors)

        self.assertEqual([row["custom_id"] for row in rows], ["migrate-catalog", "migrate-billing"])
        self.assertEqual(rows[1]["error"]["code"], "invalid_request")
        self.assertEqual(rows[1]["usage"]["total_credits"], 1.25)


class RecordingHandler(BaseHTTPRequestHandler):
    requests = []
    batch_reads = 0

    def log_message(self, *_args):
        return

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length)

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        body = self._body()
        type(self).requests.append(("POST", self.path, self.headers, body))
        if self.path == "/api/v1/cloud/files":
            self._json(200, {"id": "file_input001"})
            return
        if self.path == "/api/v1/forward/batches":
            self._json(200, {"id": "batch_example001", "status": "validating"})
            return
        self._json(404, {"error": {"message": "not found"}})

    def do_GET(self):
        type(self).requests.append(("GET", self.path, self.headers, b""))
        if self.path == "/api/v1/forward/batches/batch_example001":
            type(self).batch_reads += 1
            if type(self).batch_reads == 1:
                self._json(
                    200,
                    {
                        "id": "batch_example001",
                        "status": "processing",
                        "request_counts": {"total": 2, "pending": 0, "running": 2, "completed": 0, "failed": 0, "cancelled": 0, "expired": 0},
                        "usage": {"total_credits": 1.25},
                    },
                )
            else:
                self._json(
                    200,
                    {
                        "id": "batch_example001",
                        "status": "completed",
                        "output_file_id": "file_output001",
                        "error_file_id": "file_error001",
                        "request_counts": {"total": 2, "pending": 0, "running": 0, "completed": 1, "failed": 1, "cancelled": 0, "expired": 0},
                        "usage": {"total_credits": 2.5},
                    },
                )
            return
        if self.path in {
            "/api/v1/forward/batches/batch_example001/output",
            "/api/v1/forward/batches/batch_example001/error",
        }:
            kind = self.path.rsplit("/", 1)[-1]
            self._json(200, {"url": f"{self.server.base_url}/downloads/{kind}", "expires_at": "2030-01-01T00:00:00Z"})
            return
        if self.path == "/api/v1/forward/batches/batch_example001/tasks?limit=100":
            self._json(
                200,
                {
                    "data": [
                        {
                            "custom_id": "migrate-catalog",
                            "status": "completed",
                            "usage": {"total_credits": 2.5},
                            "artifacts": [{"file_id": "file_patch", "name": "changes.patch"}],
                        },
                        {"custom_id": "migrate-billing", "status": "failed", "artifacts": []},
                    ],
                    "has_more": False,
                    "first_id": "migrate-catalog",
                    "last_id": "migrate-billing",
                },
            )
            return
        if self.path == "/downloads/output":
            body = b'{"custom_id":"migrate-catalog","status":"completed"}\n'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/downloads/error":
            body = b'{"custom_id":"migrate-billing","status":"failed"}\n'
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._json(404, {"error": {"message": "not found"}})


class ClientTests(unittest.TestCase):
    def setUp(self):
        RecordingHandler.requests = []
        RecordingHandler.batch_reads = 0
        self.server = ThreadingHTTPServer(("", 0), RecordingHandler)
        self.server.base_url = f"http://{socket.gethostname()}:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_submit_uploads_session_resource_then_creates_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.jsonl"
            path.write_text('{"custom_id":"task-1"}\n', encoding="utf-8")
            client = QoderBatchClient("placeholder-token", base_url=self.server.base_url)

            response = client.submit(path)

        self.assertEqual(response["id"], "batch_example001")
        upload = RecordingHandler.requests[0]
        self.assertEqual(upload[:2], ("POST", "/api/v1/cloud/files"))
        self.assertIn(b'name="purpose"', upload[3])
        self.assertIn(b"session_resource", upload[3])
        create = RecordingHandler.requests[1]
        self.assertEqual(create[:2], ("POST", "/api/v1/forward/batches"))
        self.assertEqual(json.loads(create[3]), {"input_file_id": "file_input001", "completion_window": "24h"})

    def test_wait_downloads_output_and_optional_error_without_exposing_url(self):
        statuses = []
        with tempfile.TemporaryDirectory() as directory:
            client = QoderBatchClient("placeholder-token", base_url=self.server.base_url)
            final = client.wait(
                "batch_example001",
                output_dir=Path(directory),
                poll_interval=0,
                on_status=statuses.append,
            )

            self.assertEqual(final["status"], "completed")
            self.assertEqual((Path(directory) / "output.jsonl").read_text(encoding="utf-8").strip(), '{"custom_id":"migrate-catalog","status":"completed"}')
            self.assertEqual((Path(directory) / "error.jsonl").read_text(encoding="utf-8").strip(), '{"custom_id":"migrate-billing","status":"failed"}')
            tasks = json.loads((Path(directory) / "tasks.json").read_text(encoding="utf-8"))
            self.assertEqual(tasks["data"][0]["usage"]["total_credits"], 2.5)

        self.assertEqual([item["status"] for item in statuses], ["processing", "completed"])


if __name__ == "__main__":
    unittest.main()
