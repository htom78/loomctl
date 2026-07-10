#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

UPSTREAM_REPOSITORY="${LOOM_AGS_UPSTREAM_REPOSITORY:-https://github.com/ngaut/agent-git-service.git}"
UPSTREAM_REF="${LOOM_AGS_UPSTREAM_REF:-9ab722e07b0797b67da05ecb72ad3c0feae6abd3}"
SHORT_REF="${UPSTREAM_REF:0:12}"
SOURCE_DIR="${LOOM_AGS_SOURCE_DIR:-${TMPDIR:-/tmp}/loom-agent-git-service-${SHORT_REF}}"
IMAGE="${LOOM_AGS_IMAGE:-loom-agent-git-service:${SHORT_REF}}"
CONTAINER="${LOOM_AGS_CONTAINER:-loom-agent-git-service-${SHORT_REF}}"
VOLUME="${LOOM_AGS_VOLUME:-loom-agent-git-service-${SHORT_REF}-repos}"
PORT="${LOOM_AGS_PORT:-18080}"
BASE_URL="${LOOM_AGS_BASE_URL:-http://127.0.0.1:${PORT}}"
REPORT_DIR="${LOOM_AGS_REPORT_DIR:-${ROOT_DIR}/cutover-bundle/reports/local-upstream-agent-git-service}"
DATABASE_MODE="${LOOM_AGS_DATABASE_MODE:-env}"
WAIT_SECONDS="${LOOM_AGS_WAIT_SECONDS:-300}"

DOCKER_BIN="${LOOM_AGS_DOCKER_BIN:-docker}"
GIT_BIN="${LOOM_AGS_GIT_BIN:-git}"
CURL_BIN="${LOOM_AGS_CURL_BIN:-curl}"
JQ_BIN="${LOOM_AGS_JQ_BIN:-jq}"
NODE_BIN="${LOOM_AGS_NODE_BIN:-node}"

LABEL_KEY="dev.loom.integration"
LABEL_VALUE="upstream-agent-git-service-local"

usage() {
  cat <<'EOF'
Usage: scripts/upstream-agent-git-service-local.sh <command>

Commands:
  doctor    Emit a token-free local runtime readiness report.
  fetch     Clone the pinned upstream source into the dedicated source path.
  build     Build the pinned upstream Docker image.
  start     Start AGS with DB_DSN inherited from the current environment.
  wait      Wait for /readyz to report status=ready.
  verify    Run Loom's compatibility rehearsal against the live upstream server.
  stop      Remove the integration-owned container; preserve its Git volume.
  e2e-zero  Provision disposable TiDB Zero, build, start, verify, and clean up.

Configuration uses LOOM_AGS_* environment variables. Secret values are passed
to Docker and Loom through environment inheritance and are not written to JSON.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

json_bool() {
  if "$@" >/dev/null 2>&1; then
    printf 'true'
  else
    printf 'false'
  fi
}

validate_config() {
  [[ "$UPSTREAM_REF" =~ ^[0-9a-fA-F]{40}$ ]] || die "LOOM_AGS_UPSTREAM_REF must be a full 40-character git commit"
  [[ "$PORT" =~ ^[0-9]+$ ]] || die "LOOM_AGS_PORT must be numeric"
  (( PORT >= 1024 && PORT <= 65535 )) || die "LOOM_AGS_PORT must be between 1024 and 65535"
  [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] && (( WAIT_SECONDS > 0 )) || die "LOOM_AGS_WAIT_SECONDS must be a positive integer"
  case "$BASE_URL" in
    "http://127.0.0.1:${PORT}"|"http://localhost:${PORT}") ;;
    *) die "LOOM_AGS_BASE_URL must be loopback and match LOOM_AGS_PORT" ;;
  esac
  case "$DATABASE_MODE" in
    env|tidb-zero) ;;
    *) die "LOOM_AGS_DATABASE_MODE must be env or tidb-zero" ;;
  esac
}

source_commit() {
  if [[ -d "$SOURCE_DIR/.git" ]] && command_exists "$GIT_BIN"; then
    "$GIT_BIN" -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || true
  fi
}

source_origin() {
  if [[ -d "$SOURCE_DIR/.git" ]] && command_exists "$GIT_BIN"; then
    "$GIT_BIN" -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true
  fi
}

normalize_repository() {
  printf '%s' "$1" | sed -E 's#/$##; s#\.git$##'
}

source_is_pinned() {
  [[ "$(source_commit)" == "$UPSTREAM_REF" ]] || return 1
  [[ "$(normalize_repository "$(source_origin)")" == "$(normalize_repository "$UPSTREAM_REPOSITORY")" ]] || return 1
  [[ -f "$SOURCE_DIR/Dockerfile" ]]
}

source_is_clean() {
  [[ -d "$SOURCE_DIR/.git" ]] || return 1
  [[ -z "$("$GIT_BIN" -C "$SOURCE_DIR" status --porcelain 2>/dev/null)" ]]
}

docker_daemon_ready() {
  command_exists "$DOCKER_BIN" && "$DOCKER_BIN" info >/dev/null 2>&1
}

database_ready() {
  [[ "$DATABASE_MODE" == "tidb-zero" || -n "${DB_DSN:-}" ]]
}

write_doctor_report() {
  command_exists "$JQ_BIN" || die "$JQ_BIN is required to emit token-free reports"
  mkdir -p "$REPORT_DIR"

  local actual_commit actual_origin report_path
  local docker_cli docker_daemon git_cli curl_cli jq_cli node_cli source_pinned source_clean loom_built database_configured
  actual_commit="$(source_commit)"
  actual_origin="$(source_origin)"
  report_path="$REPORT_DIR/doctor.json"
  docker_cli="$(json_bool command_exists "$DOCKER_BIN")"
  docker_daemon="$(json_bool docker_daemon_ready)"
  git_cli="$(json_bool command_exists "$GIT_BIN")"
  curl_cli="$(json_bool command_exists "$CURL_BIN")"
  jq_cli="$(json_bool command_exists "$JQ_BIN")"
  node_cli="$(json_bool command_exists "$NODE_BIN")"
  source_pinned="$(json_bool source_is_pinned)"
  source_clean="$(json_bool source_is_clean)"
  loom_built="$(json_bool test -f "$ROOT_DIR/dist/index.js")"
  database_configured="$(json_bool database_ready)"

  "$JQ_BIN" -n \
    --arg repository "$(normalize_repository "$UPSTREAM_REPOSITORY")" \
    --arg pinnedRef "$UPSTREAM_REF" \
    --arg sourceDir "$SOURCE_DIR" \
    --arg actualCommit "$actual_commit" \
    --arg actualOrigin "$(normalize_repository "$actual_origin")" \
    --arg image "$IMAGE" \
    --arg container "$CONTAINER" \
    --arg baseUrl "$BASE_URL" \
    --arg databaseMode "$DATABASE_MODE" \
    --arg databaseEnvName "DB_DSN" \
    --argjson dockerCli "$docker_cli" \
    --argjson dockerDaemon "$docker_daemon" \
    --argjson gitCli "$git_cli" \
    --argjson curlCli "$curl_cli" \
    --argjson jqCli "$jq_cli" \
    --argjson nodeCli "$node_cli" \
    --argjson sourcePinned "$source_pinned" \
    --argjson sourceClean "$source_clean" \
    --argjson loomBuilt "$loom_built" \
    --argjson databaseConfigured "$database_configured" \
    '
      {
        schemaVersion: "loom-local-upstream-agent-git-service-doctor/v1",
        ok: ($dockerCli and $dockerDaemon and $gitCli and $curlCli and $jqCli and $nodeCli and $sourcePinned and $sourceClean and $loomBuilt and $databaseConfigured),
        tokenFree: true,
        targetClass: "local-upstream-e2e",
        externalStagingEligible: false,
        upstream: {
          repository: $repository,
          pinnedRef: $pinnedRef,
          sourceDir: $sourceDir,
          actualCommit: (if $actualCommit == "" then null else $actualCommit end),
          actualOrigin: (if $actualOrigin == "" then null else $actualOrigin end),
          sourcePinned: $sourcePinned,
          sourceClean: $sourceClean
        },
        runtime: {
          image: $image,
          container: $container,
          baseUrl: $baseUrl,
          dockerCli: $dockerCli,
          dockerDaemon: $dockerDaemon,
          gitCli: $gitCli,
          curlCli: $curlCli,
          jqCli: $jqCli,
          nodeCli: $nodeCli,
          loomBuilt: $loomBuilt
        },
        database: {
          mode: $databaseMode,
          envName: $databaseEnvName,
          configured: $databaseConfigured
        },
        missing: [
          if $dockerCli then empty else "runtime.dockerCli" end,
          if $dockerDaemon then empty else "runtime.dockerDaemon" end,
          if $gitCli then empty else "runtime.gitCli" end,
          if $curlCli then empty else "runtime.curlCli" end,
          if $jqCli then empty else "runtime.jqCli" end,
          if $nodeCli then empty else "runtime.nodeCli" end,
          if $sourcePinned then empty else "upstream.sourcePinned" end,
          if $sourceClean then empty else "upstream.sourceClean" end,
          if $loomBuilt then empty else "runtime.loomBuilt" end,
          if $databaseConfigured then empty else "database.DB_DSN" end
        ]
      }
    ' > "$report_path"
  "$JQ_BIN" . "$report_path"
  "$JQ_BIN" -e '.ok == true' "$report_path" >/dev/null
}

fetch_source() {
  command_exists "$GIT_BIN" || die "$GIT_BIN is required"
  if [[ -e "$SOURCE_DIR" ]]; then
    source_is_pinned || die "existing source is not the pinned upstream checkout: $SOURCE_DIR"
    source_is_clean || die "existing pinned source has local changes: $SOURCE_DIR"
    printf 'pinned upstream source already present: %s\n' "$SOURCE_DIR"
    return
  fi

  mkdir -p "$(dirname "$SOURCE_DIR")"
  "$GIT_BIN" clone --no-checkout "$UPSTREAM_REPOSITORY" "$SOURCE_DIR"
  "$GIT_BIN" -C "$SOURCE_DIR" fetch --depth 1 origin "$UPSTREAM_REF"
  "$GIT_BIN" -C "$SOURCE_DIR" checkout --detach "$UPSTREAM_REF"
  source_is_pinned || die "cloned source did not resolve to pinned commit $UPSTREAM_REF"
  source_is_clean || die "cloned source is unexpectedly dirty"
}

build_image() {
  docker_daemon_ready || die "Docker daemon is not ready"
  source_is_pinned || die "run fetch first or set LOOM_AGS_SOURCE_DIR to the pinned checkout"
  source_is_clean || die "refusing to build a dirty upstream checkout"
  "$DOCKER_BIN" build \
    --build-arg "GIT_SHA=$UPSTREAM_REF" \
    --tag "$IMAGE" \
    "$SOURCE_DIR"
}

container_exists() {
  "$DOCKER_BIN" inspect "$CONTAINER" >/dev/null 2>&1
}

container_is_owned() {
  [[ "$("$DOCKER_BIN" inspect --format "{{ index .Config.Labels \"$LABEL_KEY\" }}" "$CONTAINER" 2>/dev/null || true)" == "$LABEL_VALUE" ]]
}

volume_is_owned() {
  [[ "$("$DOCKER_BIN" volume inspect --format "{{ index .Labels \"$LABEL_KEY\" }}" "$VOLUME" 2>/dev/null || true)" == "$LABEL_VALUE" ]]
}

start_container() {
  docker_daemon_ready || die "Docker daemon is not ready"
  [[ -n "${DB_DSN:-}" ]] || die "DB_DSN must be exported before start"
  container_exists && die "container already exists: $CONTAINER"

  local admin_login admin_token
  admin_login="${LOOM_AGS_ADMIN_LOGIN:-octocat}"
  admin_token="${LOOM_AGS_ADMIN_TOKEN:-local-dev-token}"

  "$DOCKER_BIN" volume create \
    --label "$LABEL_KEY=$LABEL_VALUE" \
    "$VOLUME" >/dev/null

  DB_DSN="$DB_DSN" \
  ADMIN_LOGIN="$admin_login" \
  ADMIN_TOKEN="$admin_token" \
  ENVIRONMENT=development \
  LISTEN_MODE=production \
  PORT=8080 \
  BASE_URL="$BASE_URL" \
  "$DOCKER_BIN" run --detach \
    --name "$CONTAINER" \
    --label "$LABEL_KEY=$LABEL_VALUE" \
    --publish "127.0.0.1:${PORT}:8080" \
    --env DB_DSN \
    --env ADMIN_LOGIN \
    --env ADMIN_TOKEN \
    --env ENVIRONMENT \
    --env LISTEN_MODE \
    --env PORT \
    --env BASE_URL \
    --volume "$VOLUME:/data/repos" \
    "$IMAGE" >/dev/null
  printf 'started %s at %s\n' "$CONTAINER" "$BASE_URL"
}

wait_for_ready() {
  command_exists "$CURL_BIN" || die "$CURL_BIN is required"
  command_exists "$JQ_BIN" || die "$JQ_BIN is required"

  local second body
  for ((second = 1; second <= WAIT_SECONDS; second++)); do
    body="$("$CURL_BIN" -fsS "$BASE_URL/readyz" 2>/dev/null || true)"
    if [[ -n "$body" ]] && printf '%s' "$body" | "$JQ_BIN" -e '.status == "ready"' >/dev/null 2>&1; then
      printf 'upstream AGS ready after %ss\n' "$second"
      return
    fi
    sleep 1
  done
  "$DOCKER_BIN" logs --tail 80 "$CONTAINER" >&2 || true
  die "upstream AGS did not become ready within ${WAIT_SECONDS}s"
}

verify_candidate() {
  command_exists "$NODE_BIN" || die "$NODE_BIN is required"
  command_exists "$JQ_BIN" || die "$JQ_BIN is required"
  [[ -f "$ROOT_DIR/dist/index.js" ]] || die "run npm run build before verify"

  local admin_token compat_dir command_report integration_report readiness_file actual_commit
  admin_token="${LOOM_AGS_ADMIN_TOKEN:-local-dev-token}"
  compat_dir="$REPORT_DIR/compat"
  command_report="$REPORT_DIR/compat-rehearsal-command.json"
  integration_report="$REPORT_DIR/e2e.json"
  readiness_file="$REPORT_DIR/readyz.json"
  actual_commit="$(source_commit)"
  mkdir -p "$compat_dir"

  "$CURL_BIN" -fsS "$BASE_URL/readyz" | "$JQ_BIN" . > "$readiness_file"
  LOOM_AGENT_GIT_SERVICE_TOKEN="$admin_token" \
    "$NODE_BIN" "$ROOT_DIR/dist/index.js" harness agent-git-service-compat-rehearsal \
      --candidate-url "$BASE_URL/api/v3" \
      --candidate-token-env LOOM_AGENT_GIT_SERVICE_TOKEN \
      --out "$compat_dir" > "$command_report"

  "$JQ_BIN" -n \
    --arg repository "$(normalize_repository "$UPSTREAM_REPOSITORY")" \
    --arg pinnedRef "$UPSTREAM_REF" \
    --arg actualCommit "$actual_commit" \
    --arg sourceDir "$SOURCE_DIR" \
    --arg image "$IMAGE" \
    --arg baseUrl "$BASE_URL/api/v3" \
    --arg readinessPath "$readiness_file" \
    --arg manifestPath "$compat_dir/manifest.json" \
    --arg candidatePath "$compat_dir/candidate.json" \
    --arg comparisonPath "$compat_dir/compare.json" \
    --slurpfile readiness "$readiness_file" \
    --slurpfile manifest "$compat_dir/manifest.json" \
    --slurpfile candidate "$compat_dir/candidate.json" \
    --slurpfile comparison "$compat_dir/compare.json" \
    '
      ($readiness[0].status == "ready") as $readinessOk |
      ($manifest[0].schemaVersion == "agent-git-service-compat-rehearsal/v1" and
        $manifest[0].tokenFree == true and
        $manifest[0].candidateMode == "upstream" and
        $manifest[0].comparisonOk == true) as $manifestOk |
      ($candidate[0].ok == true and $candidate[0].requestsTokenFree == true) as $candidateOk |
      ($comparison[0].ok == true and $comparison[0].tokenFree == true) as $comparisonOk |
      {
        schemaVersion: "loom-local-upstream-agent-git-service-e2e/v1",
        ok: ($readinessOk and $manifestOk and $candidateOk and $comparisonOk and $actualCommit == $pinnedRef),
        tokenFree: true,
        targetClass: "local-upstream-e2e",
        externalStagingEligible: false,
        upstream: {
          repository: $repository,
          pinnedRef: $pinnedRef,
          actualCommit: $actualCommit,
          sourceDir: $sourceDir,
          image: $image
        },
        candidate: {
          baseUrl: $baseUrl,
          readinessStatus: $readiness[0].status
        },
        evidence: {
          readiness: $readinessPath,
          compatManifest: $manifestPath,
          candidateProbe: $candidatePath,
          comparison: $comparisonPath
        },
        gates: {
          pinnedSource: ($actualCommit == $pinnedRef),
          readinessOk: $readinessOk,
          upstreamCandidateMode: $manifestOk,
          candidateContractOk: $candidateOk,
          comparisonOk: $comparisonOk
        },
        missing: [
          if $actualCommit == $pinnedRef then empty else "upstream.pinnedSource" end,
          if $readinessOk then empty else "candidate.readiness" end,
          if $manifestOk then empty else "compat.upstreamCandidateMode" end,
          if $candidateOk then empty else "compat.candidateContract" end,
          if $comparisonOk then empty else "compat.comparison" end
        ]
      }
    ' > "$integration_report"
  "$JQ_BIN" . "$integration_report"
  "$JQ_BIN" -e '.ok == true' "$integration_report" >/dev/null
}

stop_container() {
  docker_daemon_ready || die "Docker daemon is not ready"
  if ! container_exists; then
    printf 'container is not present: %s\n' "$CONTAINER"
    return
  fi
  container_is_owned || die "refusing to remove container without integration ownership label: $CONTAINER"
  "$DOCKER_BIN" rm --force "$CONTAINER" >/dev/null
  printf 'stopped %s; preserved volume %s\n' "$CONTAINER" "$VOLUME"
}

cleanup_ephemeral() {
  if container_exists && container_is_owned; then
    "$DOCKER_BIN" rm --force "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if volume_is_owned; then
    "$DOCKER_BIN" volume rm "$VOLUME" >/dev/null 2>&1 || true
  fi
}

run_e2e_zero() {
  command_exists "$CURL_BIN" || die "$CURL_BIN is required"
  command_exists "$JQ_BIN" || die "$JQ_BIN is required"
  fetch_source
  build_image

  local zero_response db_dsn suffix
  suffix="$$-${RANDOM}"
  CONTAINER="${CONTAINER}-${suffix}"
  VOLUME="${VOLUME}-${suffix}"
  trap cleanup_ephemeral EXIT INT TERM

  zero_response="$(
    "$CURL_BIN" -fsS -X POST https://zero.tidbapi.com/v1beta1/instances \
      -H 'Content-Type: application/json' \
      -d '{"tag":"loom-agent-git-service-e2e"}'
  )"
  db_dsn="$(
    printf '%s' "$zero_response" | "$JQ_BIN" -er '
      .instance.connection as $c |
      "\($c.username):\($c.password)@tcp(\($c.host):\($c.port))/test?parseTime=true&timeout=10s&tls=true"
    '
  )"
  [[ -n "$db_dsn" ]] || die "TiDB Zero did not return a usable connection"

  export DB_DSN="$db_dsn"
  start_container
  wait_for_ready
  verify_candidate
  unset DB_DSN
  db_dsn=""
  zero_response=""
  cleanup_ephemeral
  trap - EXIT INT TERM
}

validate_config

case "${1:-}" in
  doctor) write_doctor_report ;;
  fetch) fetch_source ;;
  build) build_image ;;
  start) start_container ;;
  wait) wait_for_ready ;;
  verify) verify_candidate ;;
  stop) stop_container ;;
  e2e-zero) run_e2e_zero ;;
  -h|--help|help) usage ;;
  *) usage >&2; exit 2 ;;
esac
