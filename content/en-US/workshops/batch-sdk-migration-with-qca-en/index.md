---
schema_version: 1
slug: batch-sdk-migration-with-qca-en
title: "Bulk-Upgrade a Heterogeneous Codebase: Migration, Testing, and Repair with the QCA Batch Agent"
summary: In a 90-minute workshop, migrate four structurally different Python services in bulk, letting Agents edit code, run tests, iterate on fixes, and deliver verifiable results inside isolated sandboxes.
type: workshop
category: build-deploy
tags:
  - code-execution
  - workflow-automation
  - testing
  - verification
  - api
author:
  name: 安陈
  github: anchenqlw
locale: en-US
translation_of: batch-sdk-migration-with-qca
---

> This language version was automatically translated by AI.

## Learning goals

You will play the lead of an SDK upgrade project: four Python services all depend on the Legacy Shop SDK, but their call patterns, wrapper layers, and acceptance criteria all differ. You need to submit the four migration tasks to the QCA Batch Agent and accept the results using tests, patches, and migration reports.

After the 90-minute exercise, you will be able to:

- Prepare the exercise workspace with the Forward Environment `packages` and `setup_script`, and configure the Template, Identity, and explicit tool permissions.
- Express several code migration tasks as JSONL, upload the file, create a Batch, poll its status, and download the results.
- Track each task by `custom_id`, and accept migration results by checking tests and the scope of the changes.
- Read `error.jsonl`, fix input problems, and resubmit only the failed tasks.
- Explain off-peak scheduling, Credits, result retention, credentials, and the boundary for human review.

### The tasks you will complete

The workshop uses a synthetic Legacy Shop SDK and four mutually isolated example services; it contains no customer code and no production credentials:

| Batch Task | Migration content | Expected deliverables |
|---|---|---|
| `migrate-catalog` | Adapt to the new Product and Money return objects | A patch that passes tests, a migration report |
| `migrate-orders` | Keep the adapter, migrate idempotency parameters and exception mapping | A patch that passes tests, a migration report |
| `migrate-inventory` | Migrate the synchronous inventory interface to an asynchronous one | A patch that passes the async tests, a migration report |
| `migrate-billing` | Identify the missing business rounding policy | A human-review note, a patch that only adds that note |

Every Agent follows the same chain of work:

```text
Read the project and the migration guide
→ Edit the code
→ Run that project's tests
→ Read the new stack traces and assertion diffs
→ Adjust the implementation
→ Run the tests again
→ Pass, or escalate to human review with evidence
```

By the end of the session you should have two Batch records: the first contains three normally executing tasks and one deliberately malformed input, and the second resubmits only the Billing task that failed the first time. The final artifacts include the Batch result files, four patches, three migration reports, and one human-review note; the Billing patch may only add that review note.

## Agenda

### 0–10 minutes: Understand the tasks and the acceptance criteria

Start by reviewing the four example services and the [migration guide](https://github.com/QoderAI/cloud-agents-cookbook/blob/main/demos/batch-sdk-migration-with-qca/MIGRATION_GUIDE.md), then run the pre-migration check:

```bash
cd demos/batch-sdk-migration-with-qca
python3 check_baseline.py
```

You should see Catalog, Orders, and Inventory failing migration acceptance for different reasons, and Billing flagged as missing a business decision. These results form the starting point for the four tasks. Then review `tasks.json` and confirm each task's project directory, acceptance command, and expected deliverables.

### 10–25 minutes: Prepare the isolated environment

Before you begin you need:

- Python 3.11 or later.
- A QCA account and one Personal Access Token (PAT).
- Git, to clone the public Cookbook repository locally.
- Permission to create an Environment, Forward Template, and Identity in the QCA console.

First clone the public repository locally:

```bash
git clone https://github.com/QoderAI/cloud-agents-cookbook.git
cd cloud-agents-cookbook/demos/batch-sdk-migration-with-qca
```

In the QCA console, create a Forward Environment dedicated to this exercise. Add `git` to Packages, then copy the Demo's `FORWARD_ENVIRONMENT_SETUP.sh` in full into `setup_script`. The script runs this inside the Environment:

```bash
git clone --depth 1 \
  https://github.com/QoderAI/cloud-agents-cookbook.git \
  /workspace/cloud-agents-cookbook
```

`setup_script` is executed by `/bin/bash -lc` and runs after Packages installation; a non-zero exit makes Environment creation fail. The script also checks whether the Demo exists, so it fails explicitly when the path or the network does not match expectations instead of handing an incomplete environment to the Batch. [Create Forward Environment API](https://docs.qoder.com/cloud-agents/api/forward/environments/create)

Once the Environment is ready, create the Forward Template:

| Setting | Value for this exercise |
|---|---|
| Environment | The exercise-only Forward Environment you just created |
| Model | `performance`; before creating, you can confirm the models currently available to your account with the List Models API |
| System Prompt | Copy `TEMPLATE_SYSTEM_PROMPT.md` from the Demo |
| Built-in tools | `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `DeliverArtifacts` |
| Tool permissions | Set to `always_allow` only in this example environment, which holds no production credentials |

Forward Mode does not mount a GitHub repository in this exercise; the Agent uses the `/workspace/cloud-agents-cookbook` already prepared by the Environment. Customers also do not need to, and cannot, choose a path for repository mounting.

A Batch runs unattended. Under the current interface rules, any JSONL line fails validation as soon as a tool it uses is configured as `always_ask` or `always_deny`. Do not copy this same configuration onto a production repository just to bypass approvals; production tasks should first redesign the least-privilege, network, credential, and human-approval boundaries.

Then create an Identity dedicated to this exercise, and note the IDs with the `tmpl_` and `idn_` prefixes. QCA's [Template API](https://docs.qoder.com/cloud-agents/api/forward/templates/create) and [Identity API](https://docs.qoder.com/cloud-agents/api/forward/identities/create) define the fields.

Set the variables in your current terminal, and do not write real values into the repository:

```bash
export QODER_PAT="<your QCA PAT>"
export QODER_TEMPLATE_ID="<tmpl_...>"
export QODER_IDENTITY_ID="<idn_...>"
```

### 25–40 minutes: Read the four migration tasks

Open `tasks.json`. Each task may modify only one project directory and comes with its own acceptance command. The Agents must follow three shared constraints:

1. Read the migration guide and the target project first; do not modify tests, the Modern SDK mock implementation, or other projects.
2. Actually run the acceptance command; "the code looks correct" cannot stand in for test results.
3. When tests pass, deliver `changes.patch` and `migration-report.md`; when a business decision is missing, deliver `manual-review.md` and do not invent a policy.

This task split gives every Batch Task an explicit scope and an executable acceptance condition. The four task lines can be scheduled by independent sessions; a failure in one project does not stop other valid JSONL lines from running, and results are tracked separately by `custom_id`.

### 40–55 minutes: Generate and submit the Batch

First run the offline unit tests shipped with the Demo. They use a local mock service, do not reach QCA, and consume no Credits:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

Generate the JSONL containing the four task lines. To demonstrate that "one invalid line does not block the others," the command deliberately removes `identity_id` from the Billing line:

```bash
python3 qca_batch.py prepare \
  --tasks tasks.json \
  --output .work/batch-input.jsonl \
  --inject-invalid migrate-billing
```

When you inspect the file you should see only task instructions and resource IDs, and no token at all:

```bash
python3 qca_batch.py inspect --input .work/batch-input.jsonl
```

Upload the JSONL and create a `24h` Batch:

```bash
export BATCH_ID="$(python3 qca_batch.py submit \
  --input .work/batch-input.jsonl)"
printf '%s\n' "$BATCH_ID"
```

The client first uploads the file to `/api/v1/cloud/files`, explicitly using `purpose=session_resource`, and then calls `POST /api/v1/forward/batches`. `custom_id` is used to map each line back to its result; one Batch supports up to 10,000 lines, with a global concurrency limit of 50. [Create Batch API](https://docs.qoder.com/cloud-agents/api/forward/batches/create)

> Execution timing differs for in-room and online readers: QCA Batch currently runs only in the server-configured off-peak window `22:00–08:00` by default. An in-person workshop can follow the session schedule after the host explicitly confirms that immediate execution has been temporarily enabled; online readers should expect the Batch to sit in `queued` first and start at the next off-peak window. `completion_window` is the maximum completion deadline, not a promise of immediate execution.

### 55–70 minutes: Watch the tasks and download the results

Poll the Batch until it reaches `completed`, `failed`, `cancelled`, or `expired`:

```bash
python3 qca_batch.py wait \
  --batch-id "$BATCH_ID" \
  --output-dir .work/results
```

While waiting, the client prints the aggregate status and task counts; after a terminal state it downloads `output.jsonl`, then downloads `error.jsonl` if failed lines exist, and saves `tasks.json` through the List Batch Tasks API. The pre-signed download URL contains temporary access parameters, so the client does not print it; also avoid running the download in a terminal with `set -x` enabled.

Check each task using `custom_id`:

```bash
python3 qca_batch.py summarize \
  --output .work/results/output.jsonl \
  --errors .work/results/error.jsonl \
  --tasks-report .work/results/tasks.json
```

The `usage.total_credits` value in the task list is measured in CAS Credits, not token counts or currency amounts, and should be used as the per-task reconciliation basis. The Batch detail may also return an aggregate `usage.total_credits`, but the client should not assume it is always present. Download links expire, and Batch result files are retained for 30 days; results you need for audit should be saved promptly into your own controlled storage. [List Batch Tasks API](https://docs.qoder.com/cloud-agents/api/forward/batches/list-tasks)

If a valid line returns `session_error`, first look at the `custom_id`, error code, Credits, and artifacts in `tasks.json`:

- `All models failed` or `model queue recovery attempts exceeded` are execution-layer failures and do not mean the migration tests failed. When there are no artifacts, you can resubmit only those lines.
- If a test reports that a relative directory does not exist, check whether the task prompt still contains `cd /workspace/cloud-agents-cookbook/demos/batch-sdk-migration-with-qca && ...`; do not rely on the Agent guessing the current working directory.
- Do not resubmit tasks that already succeeded and delivered artifacts, to avoid consuming Credits twice.

### 70–82 minutes: Resubmit only the failed tasks

The Billing line in the first Batch should appear in `error.jsonl` because `identity_id` is missing, while the other valid lines keep running. Using the `custom_id` of the failed line, rebuild a valid JSONL from the original task list:

```bash
python3 qca_batch.py retry \
  --tasks tasks.json \
  --errors .work/results/error.jsonl \
  --output .work/retry-input.jsonl
```

Submit again:

```bash
export RETRY_BATCH_ID="$(python3 qca_batch.py submit \
  --input .work/retry-input.jsonl)"
python3 qca_batch.py wait \
  --batch-id "$RETRY_BATCH_ID" \
  --output-dir .work/retry-results
```

A resubmission is a new Batch and can reuse the `custom_id` from the previous one. Do not rerun the whole batch, or you will consume Credits twice and blur the mapping between first-time successes and retry results.

### 82–90 minutes: Accept the work with deterministic evidence

Download the patch and report delivered by each completed task, apply the patch on a clean local clone branch, and then run the acceptance command from the task list. Check at least:

- Whether the Agent modified only the project directory it was assigned.
- Whether the acceptance tests for Catalog, Orders, and Inventory genuinely pass.
- Whether the test files and the Modern SDK mock implementation remain unchanged.
- Whether Billing submitted a human-review note instead of guessing the rounding policy, and whether its patch only adds that note.
- Whether the reports record the commands executed, the test results, and the remaining risks.

The Agent's replies, patches, and reports are only candidate results; passing tests together with human review form the quality gate. The workshop does not require pushing changes back to the remote automatically, and it does not authorize an Agent to touch a production repository.

## Exercises and recap

### Required exercise

Complete one four-task Batch that includes a controlled validation error, and resubmit only the failed Billing line. Accept the work with this checklist:

- [ ] An exercise-only Template and Identity were created, and your own resource IDs are recorded.
- [ ] The Environment prepares the public example repository through `setup_script`, and the Template binds no GitHub repository and contains no production credentials.
- [ ] Every JSONL line has a unique `custom_id`, and the PAT did not enter the file.
- [ ] The valid lines in the first Batch kept running, and the line with the missing field went into `error.jsonl` on its own.
- [ ] The second Batch contains only the task that failed the first time.
- [ ] All three code migration tasks had their patch, change scope, and test results checked.
- [ ] The Billing business ambiguity went to human review and was not silently guessed by the Agent.
- [ ] You can read per-task Credits from List Batch Tasks, and you understand that the aggregate Batch `usage` may exist but is not guaranteed, along with the 30-day retention boundary of the output files.

### Extension exercise

Add a migration task for a fifth service, for example a paginated interface, a streaming return, or a changed configuration initialization. Prepare an independent project directory and acceptance tests for it, fill in a unique `custom_id`, writable directory, acceptance command, and expected result in `tasks.json`, and then submit that task on its own. Afterwards, check whether it delivers the patch, report, and test evidence as agreed.

When you are done, delete the local `.work/`, archive the patches and reports you want to keep, and disable or delete the exercise-only Identity, Template, Environment, and credentials in the console. Cleanup actions and actual Credits are authoritative in your own account console.

## Demo source

The Demo provides four synthetic migration projects, the Template system prompt, the task list, a pure Python standard-library Batch client, and mock unit tests. The complete run, verification, failure resubmission, cleanup, and cost notes are in the README.

[View the Demo source](https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/batch-sdk-migration-with-qca)
