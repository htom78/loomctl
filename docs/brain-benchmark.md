# Brain A/B Benchmark

Brain proposals are hypotheses, not improvements. A skill change may be merged
only after paired harness runs show a measurable task-success gain without an
unacceptable cost, token, or duration regression.

## Produce Paired Evidence

Run every benchmark case once with the baseline skill revision and once with
the candidate revision. Keep these inputs identical inside each pair:

- goal;
- agent mode, model, and model protocol;
- verification, evaluation, and reviewer commands;
- review and deployment gate requirements.

Both run summaries must list the skill under test in `skills`. Use immutable git
commit SHAs for `baselineRevision` and `candidateRevision` when the benchmark is
recorded for a pull request.

Create a manifest beside the run summaries:

```json
{
  "schemaVersion": "loom-brain-ab-benchmark/v1",
  "benchmarkId": "coding-skill-pr-42",
  "skill": "coding",
  "baselineRevision": "0123456789abcdef0123456789abcdef01234567",
  "candidateRevision": "89abcdef0123456789abcdef0123456789abcdef",
  "cases": [
    {
      "id": "typescript-fix-01",
      "baselineSummary": "baseline/typescript-fix-01/summary.json",
      "candidateSummary": "candidate/typescript-fix-01/summary.json"
    }
  ]
}
```

Summary paths are resolved relative to the manifest. A summary file may appear
only once, preventing duplicated evidence from inflating the sample size.

## Evaluate And Gate

```bash
loom brain benchmark \
  --input .brain/benchmarks/coding-skill-pr-42.json \
  --report .brain/benchmarks/coding-skill-pr-42.report.json
```

The command always writes the report when the manifest is valid. It exits zero
only for `decision: "promote"`; `hold` and `reject` exit nonzero so the command
can be used directly as a CI or required pull-request check.

The report hashes the manifest and every run summary. It records case IDs, run
IDs, statuses, pass decisions, duration, model usage, paired outcomes, aggregate
metrics, gate evidence, and failed gate names. It deliberately hashes rather
than copies run goals, and does not copy command output or error text.

## Default Gates

| Gate | Default |
|---|---:|
| Paired cases | at least 10 |
| Candidate pass-rate gain | at least 5 percentage points |
| Paired direction | wins greater than losses |
| Exact one-sided paired p-value | at most 0.05 |
| Paired efficiency samples | at least 3 |
| Mean cost increase | at most 10% |
| Mean token increase | at most 10% |
| Mean duration increase | at most 20% |

Duration evidence is required by default. Cost and token gates apply whenever
at least three pairs contain both measurements. Add `--require-cost` or
`--require-tokens` when those measurements must be present for promotion.

Thresholds can be committed under manifest `gate` or overridden by the
corresponding CLI flags. A CLI override is visible in `report.gateConfig`.

## Decisions

- `promote`: every gate passed.
- `hold`: the candidate is not proven worse, but sample size, gain, paired
  direction, significance, or required metric evidence is insufficient.
- `reject`: task success regressed, paired losses exceed wins, or an applicable
  efficiency metric exceeded its regression limit.

A run counts as passed only when its status reached a successful harness gate,
verification passed, optional evaluation and reviewer results did not fail, and
no human review or deployment gate was rejected.

`--allow-different-models` exists for explicit cross-model experiments. Do not
use it for normal skill promotion because it removes the model-confound guard.

## Pull Request Policy

`loom brain propose` now writes this benchmark requirement into every generated
improvement proposal. Store the manifest and report in the git-backed skills
repository, attach the report to the pull request check, and merge only when the
current candidate report is hash-anchored and says `promote`.
