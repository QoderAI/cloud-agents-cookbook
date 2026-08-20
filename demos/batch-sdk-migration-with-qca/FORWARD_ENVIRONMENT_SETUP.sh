#!/usr/bin/env bash
set -euo pipefail

readonly cookbook_dir="/workspace/cloud-agents-cookbook"
readonly demo_dir="${cookbook_dir}/demos/batch-sdk-migration-with-qca"

if [[ -e "${cookbook_dir}" ]]; then
  printf 'setup failed: target already exists: %s\n' "${cookbook_dir}" >&2
  exit 1
fi

git clone --depth 1 \
  https://github.com/QoderAI/cloud-agents-cookbook.git \
  "${cookbook_dir}"

if [[ ! -f "${demo_dir}/tasks.json" ]]; then
  printf 'setup failed: workshop demo is missing: %s\n' "${demo_dir}" >&2
  exit 1
fi

printf 'workshop workspace ready: %s\n' "${demo_dir}"
