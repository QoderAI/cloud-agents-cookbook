#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0

"""Minimal QCA Forward Batch client used by the Workshop.

The module intentionally uses only the Python standard library. It never logs
authorization headers or pre-signed result URLs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Callable, Iterable
from urllib import error, request


DEFAULT_BASE_URL = "https://api.qoder.com"
TERMINAL_STATUSES = {"completed", "failed", "cancelled", "expired"}


class QoderApiError(RuntimeError):
    """A sanitized API error that does not expose credentials or signed URLs."""


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            value = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}: line {number} is not valid JSON: {exc.msg}") from exc
        if not isinstance(value, dict):
            raise ValueError(f"{path}: line {number} must contain a JSON object")
        rows.append(value)
    return rows


def write_jsonl(path: Path, rows: Iterable[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows)
    path.write_text(content, encoding="utf-8")


def load_tasks(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, list) or not tasks:
        raise ValueError(f"{path}: expected a non-empty 'tasks' array")
    required = {"custom_id", "project_path", "acceptance_command", "outcome"}
    seen = set()
    for index, task in enumerate(tasks, start=1):
        if not isinstance(task, dict) or not required.issubset(task):
            missing = sorted(required - set(task) if isinstance(task, dict) else required)
            raise ValueError(f"{path}: task {index} is missing {', '.join(missing)}")
        custom_id = task["custom_id"]
        if custom_id in seen:
            raise ValueError(f"{path}: duplicate custom_id {custom_id!r}")
        seen.add(custom_id)
    return tasks


def task_prompt(task: dict) -> str:
    target = task["project_path"]
    command = task["acceptance_command"]
    workspace = "/workspace/cloud-agents-cookbook/demos/batch-sdk-migration-with-qca"
    remote_command = f"cd {workspace} && {command}"
    if task["outcome"] == "manual-review":
        outcome = (
            "This task is expected to require a business decision. Do not guess. "
            f"If MIGRATION_GUIDE.md does not define the required policy, create {target}/manual-review.md "
            f"with the missing decision, evidence, and a safe next step. Run `{remote_command}`, "
            f"then run `git diff --binary -- {target} > changes.patch` and deliver changes.patch plus "
            f"{target}/manual-review.md with DeliverArtifacts. The patch must add only manual-review.md."
        )
    else:
        outcome = (
            f"Complete the migration and run `{remote_command}` until it passes. Then write "
            f"{target}/migration-report.md, run `git diff --binary -- {target} > changes.patch`, "
            f"and deliver changes.patch plus {target}/migration-report.md with DeliverArtifacts."
        )
    return "\n".join(
        [
            f"Before every relative Bash command, change directory to {workspace}.",
            "Read TEMPLATE_SYSTEM_PROMPT.md and MIGRATION_GUIDE.md before changing code.",
            f"Your only writable project scope is {target}.",
            f"Local acceptance command: {command}",
            outcome,
        ]
    )


def build_batch_lines(
    tasks: list[dict],
    template_id: str,
    identity_id: str,
    inject_invalid: str | None = None,
) -> list[dict]:
    if inject_invalid and inject_invalid not in {task["custom_id"] for task in tasks}:
        raise ValueError(f"unknown custom_id for --inject-invalid: {inject_invalid}")
    lines = []
    for task in tasks:
        line = {
            "custom_id": task["custom_id"],
            "template_id": template_id,
            "identity_id": identity_id,
            "body": {"input": task_prompt(task)},
        }
        if task["custom_id"] == inject_invalid:
            del line["identity_id"]
        lines.append(line)
    return lines


def build_retry_lines(
    tasks: list[dict],
    error_rows: list[dict],
    template_id: str,
    identity_id: str,
) -> list[dict]:
    failed_ids = {
        row.get("custom_id")
        for row in error_rows
        if row.get("status") == "failed" and isinstance(row.get("custom_id"), str)
    }
    task_ids = {task["custom_id"] for task in tasks}
    unknown = sorted(failed_ids - task_ids)
    if unknown:
        raise ValueError(f"error file contains custom_id values absent from tasks: {', '.join(unknown)}")
    selected = [task for task in tasks if task["custom_id"] in failed_ids]
    if not selected:
        raise ValueError("error file contains no failed tasks to retry")
    return build_batch_lines(selected, template_id, identity_id)


def merge_result_rows(output_rows: list[dict], error_rows: list[dict]) -> list[dict]:
    """Return one row per custom_id, overlaying errors without losing task usage."""
    order = []
    by_custom_id = {}
    for row in [*output_rows, *error_rows]:
        custom_id = row.get("custom_id")
        if not isinstance(custom_id, str):
            continue
        if custom_id not in by_custom_id:
            order.append(custom_id)
        previous = by_custom_id.get(custom_id, {})
        by_custom_id[custom_id] = {**previous, **row}
    return [by_custom_id[custom_id] for custom_id in order]


class QoderBatchClient:
    def __init__(self, token: str, base_url: str = DEFAULT_BASE_URL, timeout: float = 30):
        if not token:
            raise ValueError("Qoder PAT is required")
        self.token = token
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _api_headers(self, content_type: str | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    def _json_request(self, method: str, path: str, payload: dict | None = None) -> dict:
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        req = request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers=self._api_headers("application/json" if body is not None else None),
        )
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            try:
                detail = json.loads(exc.read().decode("utf-8"))
                message = detail.get("error", {}).get("message") or detail.get("message")
            except (json.JSONDecodeError, UnicodeDecodeError):
                message = None
            suffix = f": {message}" if message else ""
            raise QoderApiError(f"QCA API {method} {path} returned HTTP {exc.code}{suffix}") from exc
        except error.URLError as exc:
            raise QoderApiError(f"QCA API {method} {path} could not be reached") from exc

    def upload_input(self, input_path: Path) -> str:
        boundary = f"qca-workshop-{uuid.uuid4().hex}"
        file_bytes = input_path.read_bytes()
        parts = [
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nsession_resource\r\n".encode(),
            (
                f"--{boundary}\r\n"
                f"Content-Disposition: form-data; name=\"file\"; filename=\"{input_path.name}\"\r\n"
                "Content-Type: application/jsonl\r\n\r\n"
            ).encode(),
            file_bytes,
            f"\r\n--{boundary}--\r\n".encode(),
        ]
        req = request.Request(
            f"{self.base_url}/api/v1/cloud/files",
            data=b"".join(parts),
            method="POST",
            headers=self._api_headers(f"multipart/form-data; boundary={boundary}"),
        )
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            raise QoderApiError(f"QCA Files upload returned HTTP {exc.code}") from exc
        except error.URLError as exc:
            raise QoderApiError("QCA Files upload could not be reached") from exc
        file_id = payload.get("id")
        if not isinstance(file_id, str) or not file_id:
            raise QoderApiError("QCA Files upload response did not contain an id")
        return file_id

    def create_batch(self, input_file_id: str, completion_window: str = "24h") -> dict:
        return self._json_request(
            "POST",
            "/api/v1/forward/batches",
            {"input_file_id": input_file_id, "completion_window": completion_window},
        )

    def submit(self, input_path: Path, completion_window: str = "24h") -> dict:
        return self.create_batch(self.upload_input(input_path), completion_window)

    def get_batch(self, batch_id: str) -> dict:
        return self._json_request("GET", f"/api/v1/forward/batches/{batch_id}")

    def list_tasks(self, batch_id: str) -> list[dict]:
        tasks = []
        after_id = None
        while True:
            suffix = "?limit=100"
            if after_id:
                from urllib.parse import quote

                suffix += f"&after_id={quote(after_id, safe='')}"
            page = self._json_request("GET", f"/api/v1/forward/batches/{batch_id}/tasks{suffix}")
            rows = page.get("data")
            if not isinstance(rows, list):
                raise QoderApiError("List Batch Tasks response did not contain a data array")
            tasks.extend(row for row in rows if isinstance(row, dict))
            if not page.get("has_more"):
                return tasks
            after_id = page.get("last_id")
            if not isinstance(after_id, str) or not after_id:
                raise QoderApiError("List Batch Tasks response omitted last_id while has_more=true")

    def _download_result(self, batch_id: str, kind: str, destination: Path) -> None:
        result = self._json_request("GET", f"/api/v1/forward/batches/{batch_id}/{kind}")
        signed_url = result.get("url")
        if not isinstance(signed_url, str) or not signed_url:
            raise QoderApiError(f"Batch {kind} response did not contain a download URL")
        try:
            with request.urlopen(signed_url, timeout=self.timeout) as response:
                content = response.read()
        except (error.HTTPError, error.URLError) as exc:
            raise QoderApiError(f"Batch {kind} file download failed") from exc
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)

    def wait(
        self,
        batch_id: str,
        output_dir: Path,
        poll_interval: float = 15,
        on_status: Callable[[dict], None] | None = None,
    ) -> dict:
        while True:
            batch = self.get_batch(batch_id)
            if on_status:
                on_status(batch)
            if batch.get("status") in TERMINAL_STATUSES:
                break
            time.sleep(poll_interval)
        if batch.get("output_file_id"):
            self._download_result(batch_id, "output", output_dir / "output.jsonl")
        if batch.get("error_file_id"):
            self._download_result(batch_id, "error", output_dir / "error.jsonl")
        tasks = self.list_tasks(batch_id)
        (output_dir / "tasks.json").write_text(
            json.dumps({"data": tasks}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return batch


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"environment variable {name} is required")
    return value


def client_from_env() -> QoderBatchClient:
    return QoderBatchClient(
        require_env("QODER_PAT"),
        base_url=os.environ.get("QODER_API_BASE", DEFAULT_BASE_URL),
    )


def status_line(batch: dict) -> str:
    counts = batch.get("request_counts") or {}
    usage = batch.get("usage") or {}
    values = [
        f"status={batch.get('status', 'unknown')}",
        f"total={counts.get('total', 0)}",
        f"pending={counts.get('pending', 0)}",
        f"running={counts.get('running', 0)}",
        f"completed={counts.get('completed', 0)}",
        f"failed={counts.get('failed', 0)}",
    ]
    if "total_credits" in usage:
        values.append(f"credits={usage['total_credits']}")
    return " ".join(values)


def command_prepare(args: argparse.Namespace) -> None:
    tasks = load_tasks(args.tasks)
    lines = build_batch_lines(
        tasks,
        require_env("QODER_TEMPLATE_ID"),
        require_env("QODER_IDENTITY_ID"),
        inject_invalid=args.inject_invalid,
    )
    write_jsonl(args.output, lines)
    print(f"wrote {len(lines)} task(s) to {args.output}", file=sys.stderr)


def command_inspect(args: argparse.Namespace) -> None:
    rows = read_jsonl(args.input)
    for row in rows:
        summary = {
            "custom_id": row.get("custom_id"),
            "template_id": row.get("template_id"),
            "has_identity_id": bool(row.get("identity_id")),
            "input_characters": len((row.get("body") or {}).get("input", "")),
        }
        print(json.dumps(summary, ensure_ascii=False))


def command_submit(args: argparse.Namespace) -> None:
    result = client_from_env().submit(args.input, completion_window=args.completion_window)
    batch_id = result.get("id")
    if not isinstance(batch_id, str) or not batch_id:
        raise QoderApiError("Create Batch response did not contain an id")
    print(batch_id)


def command_wait(args: argparse.Namespace) -> None:
    final = client_from_env().wait(
        args.batch_id,
        output_dir=args.output_dir,
        poll_interval=args.poll_interval,
        on_status=lambda batch: print(status_line(batch), file=sys.stderr),
    )
    print(json.dumps({"id": final.get("id"), "status": final.get("status")}, ensure_ascii=False))


def command_retry(args: argparse.Namespace) -> None:
    lines = build_retry_lines(
        load_tasks(args.tasks),
        read_jsonl(args.errors),
        require_env("QODER_TEMPLATE_ID"),
        require_env("QODER_IDENTITY_ID"),
    )
    write_jsonl(args.output, lines)
    print(f"wrote {len(lines)} retry task(s) to {args.output}", file=sys.stderr)


def command_summarize(args: argparse.Namespace) -> None:
    output_rows = read_jsonl(args.output) if args.output.exists() else []
    error_rows = read_jsonl(args.errors) if args.errors and args.errors.exists() else []
    task_rows = []
    if args.tasks_report and args.tasks_report.exists():
        report = json.loads(args.tasks_report.read_text(encoding="utf-8"))
        if not isinstance(report, dict) or not isinstance(report.get("data"), list):
            raise ValueError(f"{args.tasks_report}: expected an object with a data array")
        task_rows = [row for row in report["data"] if isinstance(row, dict)]
    rows = merge_result_rows(task_rows or output_rows, error_rows)
    for row in rows:
        usage = row.get("usage") or {}
        error_value = row.get("error") or {}
        print(
            json.dumps(
                {
                    "custom_id": row.get("custom_id"),
                    "status": row.get("status"),
                    "credits": usage.get("total_credits"),
                    "error_code": error_value.get("code"),
                    "artifacts": [item.get("name") for item in row.get("artifacts", [])],
                },
                ensure_ascii=False,
            )
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="QCA Batch Workshop client")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="build Batch JSONL from tasks.json")
    prepare.add_argument("--tasks", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--inject-invalid")
    prepare.set_defaults(func=command_prepare)

    inspect = subparsers.add_parser("inspect", help="print a credential-safe JSONL summary")
    inspect.add_argument("--input", type=Path, required=True)
    inspect.set_defaults(func=command_inspect)

    submit = subparsers.add_parser("submit", help="upload JSONL and create a Batch")
    submit.add_argument("--input", type=Path, required=True)
    submit.add_argument("--completion-window", choices=("24h", "48h", "72h"), default="24h")
    submit.set_defaults(func=command_submit)

    wait_parser = subparsers.add_parser("wait", help="poll a Batch and download terminal results")
    wait_parser.add_argument("--batch-id", required=True)
    wait_parser.add_argument("--output-dir", type=Path, required=True)
    wait_parser.add_argument("--poll-interval", type=float, default=15)
    wait_parser.set_defaults(func=command_wait)

    retry = subparsers.add_parser("retry", help="rebuild valid JSONL for failed custom_id values")
    retry.add_argument("--tasks", type=Path, required=True)
    retry.add_argument("--errors", type=Path, required=True)
    retry.add_argument("--output", type=Path, required=True)
    retry.set_defaults(func=command_retry)

    summarize = subparsers.add_parser("summarize", help="summarize output and error JSONL")
    summarize.add_argument("--output", type=Path, required=True)
    summarize.add_argument("--errors", type=Path)
    summarize.add_argument("--tasks-report", type=Path)
    summarize.set_defaults(func=command_summarize)
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        args.func(args)
        return 0
    except (OSError, ValueError, QoderApiError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
