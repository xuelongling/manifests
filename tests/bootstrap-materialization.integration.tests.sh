#!/usr/bin/env bash
# SPDX-License-Identifier: MIT

set -euo pipefail

manifest_oid="c0ea4bb1d32f80cea00d852fe6e36950e2aee598"
tsfg_oid="eb2838e4c4910113b23072b40c526a8b2843f744"
agents_oid="20e5cb5e50c38c5a6fde9ed9b7875f9b405648e4"
workspace=""
created_workspace="false"

if [[ ${1:-} == "--workspace" ]]; then
  workspace=${2:?--workspace requires a materialized Repo Workspace path}
elif [[ $# -ne 0 ]]; then
  printf 'usage: %s [--workspace <path>]\n' "$0" >&2
  exit 2
fi

cleanup() {
  if [[ $created_workspace == "true" && ${TSFG_KEEP_WORKSPACE:-0} != "1" ]]; then
    case $workspace in
      /tmp/tsfg-r00-*) rm -rf -- "$workspace" ;;
      *) printf 'refusing to remove unexpected integration-test path: %s\n' "$workspace" >&2 ;;
    esac
  fi
}
trap cleanup EXIT

if [[ -z $workspace ]]; then
  launcher=${TSFG_REPO_LAUNCHER:?set TSFG_REPO_LAUNCHER to the verified repo 2.65 launcher}
  python_command=${PYTHON:-python3}
  workspace=$(mktemp -d /tmp/tsfg-r00-XXXXXX)
  created_workspace="true"
  (
    cd "$workspace"
    "$python_command" "$launcher" init \
      --worktree \
      -u https://github.com/xuelongling/manifests.git \
      -b "$manifest_oid" \
      -m bootstrap/r00.xml \
      --repo-rev=v2.65
    "$python_command" "$launcher" sync --verify
  )
fi

cd "$workspace"

[[ $(git -C .repo/manifests rev-parse HEAD) == "$manifest_oid" ]]
[[ $(git -C .repo/manifests.git config --get branch.default.merge) == "$manifest_oid" ]]
[[ $(cat .repo/project.list) == $'.agents\ntsfg' ]]

[[ $(git -C tsfg rev-parse HEAD) == "$tsfg_oid" ]]
[[ $(git -C .agents rev-parse HEAD) == "$agents_oid" ]]
[[ $(git -C tsfg config --get remote.github-xuelongling.url) == "https://github.com/xuelongling/tsfg.git" ]]
[[ $(git -C .agents config --get remote.github-xuelongling.url) == "https://github.com/xuelongling/.agents.git" ]]
[[ $(git -C tsfg rev-parse --is-shallow-repository) == "false" ]]
[[ $(git -C .agents rev-parse --is-shallow-repository) == "false" ]]
[[ -z $(git -C tsfg config --get extensions.partialClone || true) ]]
[[ -z $(git -C .agents config --get extensions.partialClone || true) ]]

for mapping in \
  "AGENTS.md:.agents/AGENTS.md" \
  ".codex/config.toml:.agents/codex/config.toml" \
  ".codex/hooks.json:.agents/codex/hooks.json"
do
  destination=${mapping%%:*}
  source=${mapping#*:}
  [[ -L $destination ]]
  [[ $(readlink -f "$destination") == "$(readlink -f "$source")" ]]
  cmp --silent "$destination" "$source"
done

[[ -d .agents/skills ]]
[[ ! -e .repo/manifests/default.xml ]]

printf 'PASS fresh Bootstrap Integration Snapshot materialization at %s\n' "$workspace"
