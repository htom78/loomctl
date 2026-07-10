# loomctl

v3 云端 agentic 开发平台的**操作 CLI**(名字是占位,随你改)。

现在有两条 loop 路径:

1. **自建 harness/loop** —— `loom harness run` 是 OpenHands-lite MVP:事件日志、工具运行时、agent 适配器、验证门禁。
2. **原生适配器** —— `loom goal` 仍可委托 Claude Code / Codex `/goal`,用于保留旧的薄模式。

更大的平台目标保持不变:

1. **多用户在线沙箱开发** —— 每人持久 workspace、项目、租户隔离。
2. **共享控制面** —— Gitea/Forgejo 看板 + 中心 LiteLLM 网关。
3. **技能自演化 brain** —— 抓 run 信号、给技能打分、开 git-backed 的改进 PR。

## 愿景锁

MVP 不是把目标缩小,只是我们自己 harness/loop 的第一片。

MVP 跑通以后也不能丢掉这些目标:

- 多用户租户 + 隔离的持久沙箱;
- 在线开发 session 的 Web/API 控制面;
- Coder/Gitea/LiteLLM 集成;
- `ngaut/agent-git-service` 作为共享控制面候选保留在 `VISION.md`;Gitea/Forgejo 仍是默认 provider,但 `--control-plane-provider agent-git-service` 已可用于 serve/smoke,并已有 adapter、registry 化的 provider 选择、与 provider catalog 对齐的 runtime contract metadata、`LOOM_AGENT_GIT_SERVICE_URL`/`LOOM_AGENT_GIT_SERVICE_TOKEN` 默认配置、Git remote、signed webhook identity、backup migration dry-run 证据,以及 `/api/v3` discovery 和 agent-native capability catalog 证据;
- 人能检查、能 replay 的事件化 run 历史;
- 验证是硬门禁,不是模型说 done;
- brain loop 把 run 失败转成技能/流程改进。

## 对应 v3

| v3 模块 | 这里 |
|---|---|
| 自建 loop | `loom harness run` |
| HTTP 控制面 | `loom harness serve` |
| 原生 loop 适配器 | `loom goal` → 原生 `/goal`;`hooks-install` |
| 控制面 / 看板 | Gitea / Forgejo(`giteaUrl`) |
| 中心计费 | LiteLLM(`gatewayUrl` + 每人 `LOOM_GATEWAY_KEY`) |
| 持久多项目 workspace | `loom workspace create`、`loom project add` |
| 执行边界 | `src/harness/executor.ts` 本地 `WorkspaceExecutor`;`src/harness/docker-executor.ts` Docker runner;`src/harness/coder-executor.ts` Coder SSH runner |
| **技能自演化 brain** | `loom brain ingest / score / propose` ← 真正写代码的地方 |

## 快速开始(单机 / 容器内)

```bash
npm install && npm run build && npm link
```

用脚本 agent 跑自建 harness:

```bash
mkdir -p /tmp/loom-demo
cat > /tmp/loom-script.json <<'JSON'
[
  {
    "message": "write hello.txt",
    "actions": [
      {
        "toolName": "file.write",
        "input": { "path": "hello.txt", "content": "hello\n" }
      }
    ]
  },
  { "message": "finish", "finish": true }
]
JSON

loom harness run "create hello.txt" \
  --cwd /tmp/loom-demo \
  --script /tmp/loom-script.json \
  --verify "test -f hello.txt" \
  --evaluate "test -s hello.txt" \
  --skill coding
```

产物会写到:

- `.loom/runs/<runId>/events.jsonl`
- `.loom/runs/<runId>/summary.json`

Agent/adapter 错误会同时写进 `error` 事件和 `summary.error`;带诊断的 agent 错误还可以写入 `kind` 和有界 `details`,例如截断后的模型响应片段。Agent adapter 也可以在最终 assistant step 前写入有界 `agent_retry` 事件,让 repair 尝试在 replay 和 handoff 证据里可见。Model-backed run 会记录非 secret 的 `model_usage` 事件、非默认 `metadata.modelProtocol`、聚合后的 `summary.modelUsage` token 用量,以及可用时的 LiteLLM-style response cost,用于 replay、audit 和后续计费交接。可选的 evaluator command 会在 verification 通过后、人审/部署 gate 打开前执行;失败会写入 `evaluation` 事件和 `summary.evaluation`,并把 run 标成 `failed`。HTTP 创建的 run summary、review summary、handoff package、run list、issue comment 和默认 PR body 会暴露公开 requester 身份(actor/role/clientId),但不会写出模型路由用的 secret env 名。失败 run 的 Gitea/Forgejo issue comment 也会带非 secret 的 error kind/details,方便外部 review。

用 HTTP 暴露 harness:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787
```

默认 local executor 只适合 loopback 单机开发。多人共享或外部可访问的 HTTP 服务应选择 Docker/Coder;当配置了 tenant 鉴权、非 loopback host 或开启 shell 工具时,`loom harness serve` 会拒绝隐式 local executor,除非显式传 `--allow-unsafe-local-executor`。这里的 tenant 鉴权包括 CLI keys/tokens,也包括磁盘上已有的 policy-backed `apiKeys`。

MVP 在线沙箱可用 `--profile online-sandbox` 启动隔离 executor;它会把服务端 allowlist 展开为 `file.read`、`file.write`、`git.diff`、`git.commit`、`verify.run` 和 `shell.exec`,通过 `GET /status` 报告该 profile、服务端 allowlist、机器可读的 `readiness` checklist、`readiness.goldenPath`、`server.runCreateIdempotency`、`server.concurrencyAdmission` 和 `visionLock` 目标锁,通过 `GET /tenants/:tenant/status` 暴露各 tenant 的 effective allowlist 和非敏感 `readiness`/`visionLock`,同时保留 local executor 安全闸门。它的 readiness 比安全闸门更严格:`GET /status` 和 tenant status 只有在 role-based tenant key 覆盖 `admin`、`developer`、`viewer`,且使用带 `--executor-home-root` 的 Docker 或 Coder executor 时才会报告 `readiness.ok: true` 和 `readiness.goldenPath.ok: true`,确保在线沙箱同时具备租户鉴权、隔离执行和按 tenant 持久化的 home。Tenant status 会把需要枚举 tenant/project 的 readiness 检查限定在当前 tenant,包括 model key 覆盖、tenant auth roles、control-plane agent identity、使用该 tenant control-plane token 的 AGS discovery,以及 AGS project-agent receipt/secret;global status 仍是跨 tenant 的 operator 视图,且没有全局 AGS admin token 时会聚合 tenant-scoped AGS discovery 证据,只输出非敏感的 `tokenMode`、tenant 计数和缺失 tenant 列表。完整 Coder/control-plane/LiteLLM/brain 路径用 `--profile platform-readiness`;它保留相同沙箱 allowlist 契约,并会把带 base URL 且有全局或 tenant-scoped API key 的模型路由、signed issue-comment webhook 配置、issue comment sync、control-plane issue URL 证据链接、通过 `git.pr` 与 workspace PR reporter 证明的 workspace Git transport/PR handoff、provider 派生的 `controlPlaneGitTransport.sampleRemoteUrl` 证据、run-scoped worktree 与 run-suffixed PR branch derivation 的 workspace branch lease readiness,以及 `--tenant-control-plane-token-env` 这类 tenant-scoped control-plane agent identity 一起纳入 readiness,再让 smoke 自动跑外部 readiness 检查。

启动共享服务前,先用同一组 `serve` flags 跑 `loom harness doctor`。它不会启动 server 或连接外部系统,会把 CLI `--tenant-key-env`/`--tenant-key` 和 policy-backed tenant `apiKeys` 都计入 role readiness,但不会输出 token 材料;也会报告 `serve` 实际执行的端口/数值 flag 校验、executor 配置、local-executor 安全闸门、run-create 幂等能力、workspace branch lease readiness,以及 control-plane token/webhook env 闸门;只输出 JSON: `ok`、`missing`、各 check 细节、`recommendedFlags`、`visionLock`、`controlPlane.boundary`、`controlPlane.apiBasePath`、`controlPlane.discoveryEndpoints`、`controlPlane.nativeCapabilities`、`controlPlane.adoptionStages`、profile `goldenPath`,以及和 status readiness 相同的 provider 派生 Git transport sample remote 证据;请求的 profile 不完整或这组 `serve` flags 会被拒绝时以非零退出。

给 operator 或 CI 交接时,`loom harness platform-cutover-plan` 会输出不含 token 的阶段计划;加 `--out plan.json --bundle-out cutover-bundle` 可以一次写出 plan 和 operator bundle。选择 AGS 时会在 `serve` 前自动加入 `agent-git-service-compat-rehearsal` 和 `agent-git-service-staging-readiness`,先做 upstream contract diff,再只读探测 AGS issue workspace/comment/wiki memory surface。真实 AGS staging bundle 可通过 `--agent-git-service-staging-issue`、`--agent-git-service-staging-repo`、`--agent-git-service-staging-wiki-page`、`--agent-git-service-native-write-workspace-id`、`--agent-git-service-native-write-attachment-url` 和 `--agent-git-service-native-write-wiki-note` 指定读/写 probe 目标,不必依赖默认 smoke issue;解析后的目标也会归档到 `externalEnvironment.systems.agentGitServiceStaging`。如果导入的手写 plan 已有 AGS readiness 或 native-write argv 但缺少 `agentGitServiceStaging` system entry,`platform-cutover-bundle` 会先从 argv 反推同一个不含 token 的目标,再写 bundle `plan.json` 和 `staging-ci.json`;pre-serve checks 只有在 native write stage 存在时才强制要求 native write target 字段。`--bundle-out` 或兼容命令 `loom harness platform-cutover-bundle --plan plan.json --out cutover-bundle` 会导出 `plan.json`、`manifest.json`、`env.md`、`env.sh`、`external-secrets.json`、`github-actions-staging.yml`、`commands.sh` 和 `staging-ci.json`。`external-secrets.json` 只记录必需 env 名、`ci-secret-store` provider hint 和 `source ./env.sh` 注入方式,不包含 secret value;`github-actions-staging.yml` 是可复制到 `.github/workflows/` 的不含 token 模板,把这些 env 名映射到 GitHub Actions `secrets.<NAME>` 并运行 strict pre/post/all bundle commands。`staging-ci.json` 使用 `platform-staging-ci/v1` schema,记录严格 pre/post serve 命令、必需 env 名、外部 target inventory、预期 reports 和 jq checks,不包含 secret value;它的 pre-serve jq checks 会同时校验 `bundle-verify.json`、`staging-run.json`、四个 probe gate 与空 `missing` 的 `platform-preflight/v1`、AGS staging readiness 的 discovery/issue/wiki gates、带 AGS target inventory 的外部 `staging-targets.json`、readiness 与 target 是否一致、带 `gates.preServeEvidenceOk` 的 `platform-staging-evidence/v1` 和 serve-start verdict;strict staging-run jq checks 还会要求 `platform-staging-run/v1` 本身 token-free、strict external、missing/forbidden 列表为空、bundle/env/stage/evidence/verdict gates 全绿,并 hash 锚定 bundle verify、每个 pre-serve env/run report、staging targets、staging evidence 和 staging verdict。AGS strict pre-serve jq checks 还会要求 staging-evidence rollup 本身 token-free、missing/forbidden 列表为空、external/preflight/AGS/compat gates 全过,并带有 staging targets、platform preflight、AGS staging readiness 和每个 AGS compat artifact 的 sha256 锚点。post-serve jq checks 会在最终 proof rollup 前校验 `agent-git-service-native-write-check/v1`、该 proof 与 `reports/staging-targets.json` 的一致性、`platform-serve-ready/v1`、cutover report 里的 AGS readiness、smoke status、多 agent 并发、AGS cutover、AGS workspace-token、AGS native projection、server/tenant AGS discovery 的 `tokenMode` 和空缺失租户列表,以及 `operator-artifacts.json` 对除 final artifact/proof 自引用之外所有 `staging-ci.expectedReports` 的 sha256 锚定;生成的 `staging-ci.json.commands.*` 会为真实外部 staging 默认带上 `LOOM_RUN_STAGING_CI_CHECKS=1`,本地 AGS contract rehearsal 则应直接调用 `commands.sh` 且不带这个变量,因为 upstream candidate mode 本来就不存在。AGS plan 会把 `agent-git-service-compat/{manifest,baseline,candidate,compare}.json` 列为 pre-serve artifact,并加上 upstream candidate mode、非 loopback candidate URL 和 comparison success 的 jq gate。`commands.sh` 在任何 stage 前先跑 `platform-cutover-bundle-verify --forbid-env <declared-env>` 校验 payload hash 和 secret scan,再用 `platform-staging-run` 执行 pre-serve stages,写出 `reports/staging-run.json`、`reports/staging-targets.json`、`reports/staging-evidence.json` 和 `reports/staging-verdict.json`,让真实外部 staging 能在启动长跑服务前先归档和审批。`staging-run.json` 使用 `platform-staging-run/v1` schema,汇总 bundle verify、env check、pre-serve stage run、外部 target 分类、evidence 和 verdict,并会在最终 artifact verification 中和生成的 staging evidence 一起被锚定;`staging-targets.json` 还会携带不含 token 的 AGS staging issue/repo/wiki/write target。真实 staging CI 设置 `LOOM_REQUIRE_EXTERNAL_STAGING=1` 后,脚本会在 staging-run、最终 artifact verify 和 staging proof 中要求 `--require-external-staging`;严格 external 模式还会拒绝 AGS compat manifest 中不是 `candidateMode: "upstream"` 或 `candidateBaseUrl` 不是外部 URL 的证据,并在写 `staging-evidence.json` 时就阻断,让 `staging-verdict.json` 在手动启动 `serve` 前保持 blocked;设置 `LOOM_REQUIRE_OPERATOR_APPROVALS=1` 后,最终 artifact verify 和 staging proof 还会要求审批型 mutating stage 的 run report 存在且 gate id 匹配。post-serve 自动阶段后,脚本再跑 `platform-cutover-artifacts-verify --dir . --plan plan.json --report reports/operator-artifacts.json --staging-evidence-report reports/staging-evidence.json --forbid-env <declared-env>`,再写 `reports/staging-proof.json` (`platform-staging-proof/v1`),把 staging targets、staging evidence、verdict、staging-run、serve-ready 和 operator artifacts 合成最终不含 token 的证明,避免本地 rehearsal 或缺少人工审批被当成真实外部 staging。生成的 platform-preflight/AGS staging/staging-targets/serve-ready/cutover/smoke argv 会写 `reports/platform-preflight.json`、`reports/agent-git-service-staging-readiness.json`、`reports/staging-targets.json`、`reports/serve-ready.json`、`reports/cutover-report.json` 和 `reports/smoke.json`;artifact verifier 会先要求 preflight `ok`、四个 preflight gates、空 `missing` 和 `nextCommandsReady` 都通过,并把它们显式输出为 `gates.doctorPreflightOk`、`gates.modelPreflightOk`、`gates.controlPlanePreflightOk` 和 `gates.coderPreflightOk`;同时输出 `gates.externalStagingReady`,严格模式下该 gate 必须为 true,否则 `preServeEvidenceMissing` 会包含 `stagingTargets.externalStagingReady`;同时输出 `stagingEvidence` (`platform-staging-evidence/v1`),其中包含 `reports.stagingTargets` 的 sha256/ok 引用和 `gates.externalStagingReady`,再汇总 model gateway、control-plane、Coder、AGS staging、AGS compatibility、report sha256 和 pre-serve gate 覆盖,让真实外部 staging 试运行有一份不含 token 的统一归档清单;且 AGS staging report 通过 `gates.agentGitServiceStagingReady`,才把 `gates.preServeEvidenceOk` 置为 true,再要求 cutover `ok`、smoke `status: "passed"`、multi-agent concurrency、cutover/smoke server/tenant AGS discovery 证据都通过,才把 `gates.postServeEvidenceOk` 置为 true。选择 AGS 时,plan 里的 compat stage 会写 `reports/agent-git-service-compat/{manifest,baseline,candidate,compare}.json`;`platform-cutover-run` 会为这个 stage 记录不含 token 的 `artifactSummary`,manifest 会记录 baseline/candidate/compare 的 sha256,artifact verifier 会要求这些 JSON schema/token-free/hash/stage-anchor/comparison 证据都通过,才把 `gates.agentGitServiceCompatOk` 置为 true;同时也会要求 AGS preflight compatibility、project-agent cutover 和 native projection smoke 证据通过,才允许对应的 pre/post serve gates 为 true。

最终 artifact verification 现在也会要求所有 required reports 都是 `ok`,并把 `platform-staging-run/v1` 里的 refs 与当前 report sha256 逐项比对;gate/ref rollup 不一致或指向旧文件时,手写或篡改过的 `readyForServe: true` 不能绕过 pre-serve 子证据。

AGS staging readiness 现在还会记录 upstream `/readyz` 的 `serverReadiness`;strict pre-serve jq 和 staging evidence 都要求 `serverReadiness.ok` 且 `serverReadiness.status == "ready"`,避免只有 `/api/v3` 兼容的临时服务冒充真实 ready 的 `gh-server`。

选择 AGS 时,`platform-cutover-plan` 还会在 `serve` 后列出需要显式审批的 `agent-git-service-native-write-check`;它验证 AGS issue comment、workspace attachment 和 wiki-memory 写路径,但必须由 operator 用对应 approval gate 或 `--approve-mutating` 明确解锁。严格审批模式下,最终 artifact verification 不只检查该 stage 的 run report 和 approval 汇总,还会要求实际的 `reports/agent-git-service-native-write-check.json` 是 token-free、approved、`ok` 且所有写路径 gate 都通过。

`staging-ci.json` 现在还会写 `operatorApprovals[]`:每个需要人工审批的 mutating stage 都有 stage id、gate id、evidence 文案、建议执行命令、`requires` 和报告路径,方便真实 staging CI 把副作用阶段作为人工 gate 而不是隐含说明处理。生成的审批命令会以 `"${LOOM_BIN:-loom}"` 开头,所以 CI 可以复用和 `commands.sh` 一样的本地二进制覆盖;`LOOM_BIN` 必须是可执行路径或命令名,源码树运行时用一个可执行 wrapper 脚本,不要把多词 `npx tsx ...` 直接塞进 `LOOM_BIN`。对 AGS native write stage,post-serve expected reports 和 jq checks 还会显式列出 `agent-git-service-native-write-check.json`,让 operator approval 不能替代真实写入 proof。

bundle 现在也会导出不含 token 的 `env.sh`、`external-secrets.json` 和 `github-actions-staging.yml`:前者可以被 CI `source`,只声明并导出 env name;第二个把同一组必需 env 映射到外部 secret store 交接清单,并记录 `source ./env.sh` 注入命令;workflow 模板则把 env 名映射到 GitHub Actions `secrets.<NAME>` 并运行 strict staging commands,还暴露默认值为 `loom` 的 `loom_bin` 输入、默认值为 `cutover-bundle` 的 `bundle_dir` 输入和默认值为 `22` 的 `node_version` 输入,并用 `bundle_dir` 作为 bundle working directory 和 reports artifact 路径。开启 `bootstrap_source_tree` 时,workflow 会用 `actions/setup-node` 固定 Node 版本,执行 `npm ci`、build 当前 checkout、写出 `loom-wrapper`,再把 `LOOM_BIN` 指向这个 wrapper;这些都不写入 secret value。workflow 还设置 `loom-strict-staging-${{ github.ref }}-${{ inputs.phase }}` concurrency group 和 `cancel-in-progress: false`,同一 ref/phase 的重复 staging 会排队,不会互相覆盖 reports。真实 handoff 前先跑 `loom harness platform-ci-handoff-preflight --dir cutover-bundle --repo <owner/repo> --ref <branch> --report cutover-bundle/reports/ci-handoff-preflight.json`;它会检查本地 bundle 文件、`external-secrets.json`、`gh auth status`、`gh repo view`、`gh workflow view` 和 `gh secret list --app actions`,但不保存命令输出;报告只记录 required/present/missing required env 名,以及缺失 required env 对应的不含值 `gh secret set` command args,不会记录 secret 值或仓库里其他无关 secret 名。如果缺 `github.workflow`,需要先把 workflow 复制/安装到 `.github/workflows/`,提交并推送到目标 ref,再 dispatch;如果缺 `github.secrets.requiredEnv`,需要先创建这些 GitHub Actions repository secrets。推荐运行 `loom harness platform-ci-handoff-run --dir cutover-bundle --repo <owner/repo> --ref <branch> --phase post-serve --preflight --report cutover-bundle/reports/ci-handoff-run.json`;它会先跑 preflight,再安装 workflow、dispatch、wait、同步/import artifact,并刷新 operator-status,同时保留每个 token-free 子报告。一键命令和分步 fallback 的 `platform-ci-workflow-dispatch`、`platform-ci-workflow-wait`、`platform-ci-artifact-sync` 会沿用同一个 `--repo`;dispatch 和 preflight 也会沿用 `--ref`,确保检查、触发、等待和 artifact 下载指向同一个仓库。如果省略 `--ref`,成功的 preflight 会让 `platform-ci-handoff-run` 使用 `gh repo view` 看到的默认分支继续 dispatch、run list、wait 和 artifact sync。workflow dispatch 的 run id 识别会把 `gh run list` 限定到 `workflow_dispatch` 和目标 ref,降低繁忙仓库里误匹配其他 run 的概率。如果 dispatch 或 wait 已经成功、后续步骤失败,重跑时加 `--resume` 可以复用匹配的成功 dispatch/wait 报告,避免重复创建 GitHub Actions run;resume 只接受当前 phase 与 GitHub 目标 repo/ref 都匹配的已保存 dispatch/wait 报告。分步 fallback 仍然可用:`platform-ci-handoff-preflight` 写 `ci-handoff-preflight.json`,`platform-ci-handoff-install` 写 `ci-handoff-install.json`,`platform-ci-workflow-dispatch` 写 `ci-workflow-dispatch.json`,`platform-ci-workflow-wait` 写 `ci-workflow-wait.json`,`platform-ci-artifact-sync` 写 `ci-artifact-sync.json` 和 `ci-artifact-import.json`。在 GitHub Actions 里运行 `commands.sh` 时还会写 `reports/ci-run-proof.json`,记录 run id、run URL、phase、bundle workflow sha256 和 checkout 里的已安装 workflow sha256;checkout 里的安装报告可以不存在,但如果存在就必须匹配。artifact 已经下载好时,可以用离线 fallback: `loom harness platform-ci-artifact-import --dir cutover-bundle --artifact-dir <downloaded-artifact-dir> --phase post-serve --report cutover-bundle/reports/ci-artifact-import.json`;它支持 artifact 根目录直接是 reports 文件或包含嵌套 `reports/`,并忽略额外文件。最终 strict `ciHandoffReady` 会要求本地安装报告和 run proof 同时匹配 bundle 模板和当前磁盘 workflow。`platform-operator-status` 的 `ciHandoff` 也会读取这些文件,输出 workflow 文件、sha256、必需 secret env 名、workflow concurrency guard、`bundle_dir=cutover-bundle`、复制到 `.github/workflows/github-actions-staging.yml` 的 `workflowInstall` source/destination/command steps、installer command args、已安装 workflow 的 path/existence/sha256 和 `matchesBundle`、安装报告的 path/sha256/`matchesBundle`、带 `missing`/`nextActions` 以及 required secret env 摘要和缺失 secret set command args 的 `preflight`、`handoffRun`、`workflowRun` proof 的 path/run URL/sha256/`matchesHandoff`、`workflowDispatch`、`workflowWait`、`artifactSync` 与 `artifactImport` report/command 字段、`node_version=22`、当前阶段建议的 `workflow_dispatch` phase,以及不含 secret 的 `workflowDispatchCommandArgs` 和可复制 `workflowDispatchCommand`;如果已有 preflight report,operator status 会把其中的 repo/ref 继续带入后续建议命令。`nextActions` 也会直接提示 preflight、handoff-run、安装 workflow、审计 dispatch、等待 workflow、同步/导入 artifact 和 `gh workflow run` 命令。strict post-serve jq checks 也会显式要求 `gates.ciHandoffReady`;这个 gate 现在会在已安装 workflow 与 bundle 模板 sha256 不一致、`ci-handoff-install.json` 缺失/过期、或 `ci-run-proof.json` 缺失/过期时保持红灯。`manifest.json`、bundle verify 和 hash 校验都会覆盖它们。post-serve 还会先写 `reports/serve-ready.json`,最终 artifact verification 必须看到 `gates.serveReadyOk` 才接受 cutover/smoke 证据。
`manifestFileMismatches` 会拒绝不再按顺序列出完整 operator payload 的 `manifest.files`,避免 payload 文件被排除在 hash/secret scan 之外。
`manifestHashMissingFiles` 会拒绝缺少对应 `fileSha256` 的 payload 文件,确保每个 operator payload 都被 hash 锚定。
AGS bundle 还会多导出 `upstream-agent-git-service.json` (`upstream-agent-git-service-staging-guide/v1`):它只记录 upstream repo、`gh-server`、`/api/v3`、`DB_DSN` 这个 server env 名、Loom env 名、staging issue/repo/wiki/write target,以及结构化的 upstream/Loom/pre-serve/serve/post-serve `operatorChecklist`,不写 secret value;manifest 会 hash 它,bundle verify 也会扫描它。`loom harness upstream-agent-git-service-handoff --dir cutover-bundle --report cutover-bundle/reports/upstream-agent-git-service-handoff.json` 会把这份 guide 转成不含 token 的 `upstream-agent-git-service-handoff/v1` 报告,包含 guide、server env、Loom env、checklist 和 secret-scan gates。
`platform-cutover-bundle-verify` 还会输出 `upstreamAgentGitServiceHandoffMismatches`:如果这份 handoff 和当前 plan 里的 AGS control-plane URL、token env 名、staging target 或 upstream `DB_DSN` 元数据不一致,即使同步改了 hash 也会失败。

真实外部 staging 前,可以先手动跑 `loom harness platform-staging-prerequisites --dir cutover-bundle --require-agent-git-service --report cutover-bundle/reports/staging-prerequisites.json`。strict external `commands.sh` 会先写 `reports/upstream-agent-git-service-handoff.json`,再在 pre-serve stages 前自动跑 prerequisites gate,写出 `reports/staging-prerequisites.json`,并让 strict artifact/proof checks 对两份报告做 hash 锚定。它们不打印 secret value,会检查 bundle 完整性、strict commands、必需 env 名是否存在、`LOOM_BIN`、`jq`、外部 targets、upstream AGS handoff 和 `DB_DSN` server env 名。

真实外部 pre-serve 前,可以先跑 `loom harness platform-external-staging-audit --dir cutover-bundle --report reports/external-staging-audit.json`。它不读取或输出 secret value,只聚合 bundle 完整性、必需 env 名是否存在、外部 target 分类、`staging-prerequisites.json`、strict pre-serve evidence、`staging-run.json` 和 serve-start verdict,并在 `nextActions` 里指回 bundle 的严格 pre-serve command。strict external `commands.sh` 会在 `staging-run` 后自动写出这份 audit;最终 artifacts、staging proof 和 goal audit 都会 hash 锚定它,避免跳过 operator 可读的 pre-serve 审计或复用旧文件。
任意交接阶段都可以跑 `loom harness platform-operator-status --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/operator-status.json`。它写出不含 token 的 `platform-operator-status/v1` rollup,读取 `staging-ci.json`、`plan.json`、当前 reports、GitHub Actions workflow、external secrets 和实时 `platform-goal-audit` 结果,把 bundle 归类为 `prepare-pre-serve`、`ready-for-serve`、`run-post-serve-proof` 或 `production-cutover-ready`,并给出下一条 strict pre-serve、手动 serve、post-serve、`platform-ci-handoff-preflight`、`platform-ci-handoff-run`、`platform-ci-handoff-install`、`platform-ci-workflow-dispatch`、`platform-ci-workflow-wait`、`platform-ci-artifact-sync`、`platform-ci-artifact-import` 或 workflow dispatch 命令,但不放松最终 goal gate。strict post-serve `commands.sh` 现在会在 `goal-audit` 后自动写这份 report,并用 jq 要求 `phase: "production-cutover-ready"` 和 `gates.ciHandoffReady`;如果 `.github/workflows/github-actions-staging.yml` 不存在、sha256 不等于 bundle 模板、`ci-handoff-install.json` 缺失/过期,或 GitHub Actions 写出的 `ci-run-proof.json` 缺失/过期,最终状态仍会 blocked。

如果 CI 只需要跑到手动长跑服务之前,用 `LOOM_CUTOVER_PHASE=pre-serve ./commands.sh`;真实外部 staging 再加 `LOOM_REQUIRE_EXTERNAL_STAGING=1`,需要强制审批证明时再加 `LOOM_REQUIRE_OPERATOR_APPROVALS=1`。脚本会在写出 `reports/staging-run.json`、`reports/staging-targets.json`、`reports/staging-evidence.json`、`reports/staging-verdict.json` 和 `reports/external-staging-audit.json` 后退出。verdict 使用 `platform-staging-verdict/v1` schema,只有所有 pre-serve gate 都过了才给出 `decision: "ready-for-serve"`,否则输出不含 token 的 `nextActions`。operator 启动 `serve` 后,用 `LOOM_CUTOVER_PHASE=post-serve ./commands.sh` 跳过已经审批的 pre-serve probes,先用 `/healthz`、`/readyz` 和 `/status` 写出 `reports/serve-ready.json`,再跑 cutover/smoke、最终 artifact verification 和 `reports/staging-proof.json`;严格 external 模式还会交叉校验 `platform-preflight.json` 子报告:模型 base URL 必须是外部,Coder executor 证据必须是 `kind: "coder"`,control-plane 证据必须是外部 `agent-git-service`。严格审批模式下 proof 会把 staging targets、platform preflight、staging evidence、verdict、staging-run、external staging audit、serve-ready、operator approvals 和 operator artifacts 一起归档,并校验当前的 `reports/operator-approvals.json`,不只相信旧的 `operator-artifacts.gates.operatorApprovalsOk`,还会把 `staging-ci.json.operatorApprovals[]` 当作独立的审批期望来源,把 `staging-ci.json.expectedReports` 当作额外 proof 输入并记录到 `reports.stagingCiExpectedReports`,把当前 AGS compat artifacts 纳入 `requiredReports`,并要求 `operator-artifacts.json` 锚定 external audit、核心 proof 输入、AGS compat reports、staging-ci expected reports 和每个预期 approval run report,且本身由 `requireOperatorApprovals: true` 生成。即使手写的 `expectedReports` 漏掉 approval run report,proof 也会按 `operatorApprovals[]` 重新要求对应 hash 锚定。最终 `platform-cutover-artifacts-verify` 还会要求每个审批 run report 不仅 `ok`、gate id 匹配,还要在 `satisfiedRequirements` 里记录该 stage 的全部 `requires`;它也会要求 `reports/platform-preflight.json` 是 `platform-preflight/v1` 且 `tokenFree: true`,并 secret-scan 这些 pre-serve 文件和 `serve-ready.json`,且 verdict 里的 `evidenceSha256` 不再匹配 `staging-evidence.json` 时会失败。不设置这些变量,或设为 `LOOM_CUTOVER_PHASE=all`,就是完整重跑。

doctor 通过后、`serve` 前,用同一套 serve shape 加 tenant/project/repo 和 token env 名跑 `loom harness platform-preflight`。它把 doctor、`model-preflight`、`control-plane-preflight` 和 `coder-preflight` 聚合成一个不含 token 的 `platform-preflight/v1` JSON gate,包含 `gates`、`missing`、各子报告、`nextCommandsReady`,以及给 CI 交接用的 `cutoverReportCommandArgs`/`smokeCommandArgs`;放进 cutover bundle 时传 `--report reports/platform-preflight.json`,让最终 artifact verifier 复核同一份 pre-serve gate。单项 probe 只作为排障工具保留:模型 probe 复用 model-backed run 的同一个 adapter,control-plane probe 探测 provider catalog discovery endpoints,Coder probe 走 template 渲染、可选 workspace 创建、`coder start`、repo/worktree prepare、一次 `coder ssh` 远端探针和浏览器 IDE/preview URL 证据。严格 pre-serve verification 还会拒绝只填顶层 gate 的报告:必须有 `model.checks.modelUsage`、数值化 token/cost 证据,以及 Coder `prepare`、`remoteCommand`、`browserUrls` 检查证据。`loom harness control-plane-preflight --control-plane-provider agent-git-service --report ags-preflight.json` 可以把同一份不含 token 的 AGS compatibility 结果落盘,作为 CI artifact 或以后对照 upstream `ngaut/agent-git-service` 的证据,不会保存 token 值;AGS 报告还包含稳定的 `compatibilityReport.schemaVersion` (`agent-git-service-contract-probe/v1`) 和 read-only/Bearer 元数据,方便后续 diff。`loom harness agent-git-service-staging-readiness --control-plane-url <upstream-ags-url> --control-plane-token-env <env> --issue <owner/repo#number> --repo <owner/repo> --report ags-staging.json` 会只读检查 discovery、issue workspaces、issue comments 和 wiki memory,不创建 PR/评论,也不输出 token。分别录制 contract baseline 和 upstream candidate 后,运行 `loom harness agent-git-service-compat-compare --baseline ags-contract.json --candidate ags-upstream.json --report ags-compare.json`;endpoint 或 native capability 漂移时命令非零退出,但仍会写出不含 token 的 comparison artifact。需要一键排练时,`loom harness agent-git-service-compat-rehearsal --out ags-compat` 会生成本地 contract baseline/candidate/compare artifacts;加 `--candidate-url <upstream-ags-url> --candidate-token-env <env>` 后,同一命令会用本地 contract baseline 对照真实 upstream candidate,且不打印 token。选择 `--control-plane-provider agent-git-service` 时,`platform-cutover-plan` 会把 compat rehearsal 和 staging readiness 作为 `serve` 前的只读 stage 自动加入 plan 和 bundle commands,先过 upstream 对照和 AGS 原生读能力证据,再允许后续 AGS provisioning/apply。

`agent-git-service-staging-readiness` 会先探测 upstream `/readyz` 并把 `serverReadiness` 写入报告,然后才检查 discovery、issue workspace、issue comments 和 wiki memory。

`serve` 跑起来以后,可以用 `loom harness agent-git-service-native-write-check --control-plane-url <upstream-ags-url> --control-plane-token-env <env> --issue <owner/repo#number> --repo <owner/repo> --workspace-id <workspace-id> --attachment-url <public-evidence-url> --approve-mutating --report reports/agent-git-service-native-write-check.json` 单独记录不含 token 的 AGS 写路径报告。放在 cutover bundle 里时,用 `loom harness platform-operator-approvals --dir cutover-bundle --report reports/operator-approvals.json` 可以把 `staging-ci.json.operatorApprovals[]` 和实际 run reports 汇总成 `platform-operator-approvals/v1`,明确哪些 approval report 缺失、哪个 gate id 没匹配、哪些 `requires` 没进入 `satisfiedRequirements`、下一条应执行的审批命令是什么;最终 strict artifacts 还会单独读取 `reports/agent-git-service-native-write-check.json`,确认真实 AGS 写 proof 没缺失。

严格 staging proof 还会把 `operator-approvals.json` 的每条 approval 和 `staging-ci.json.operatorApprovals[]` 对齐检查,包括 stage id、gate id、evidence、command 和必需的 `requires`,所以手写 summary 不能保留同一个 report 名却删掉 change-window 等外部要求。
它还会把 `operator-artifacts.json` 里锚定的 report sha256 和当前 report 文件重新比对,所以 preflight、AGS compatibility、native-write proof 或 approval summary 改过以后,必须重新跑最终 artifact verification。
它也会拒绝任何已存在但 `ok` 不为 true 的 required report,并在接受 proof 前重新把 `platform-staging-run/v1` 的 refs 和当前 report sha256 比对。
`platform-cutover-bundle-verify` 还会输出 `stagingCiStrictCommandMissing`:如果手改 `staging-ci.json.commands.{preServe,postServe,all}` 删掉 strict external/approval/JQ-check env 或 `./commands.sh`,即使同步改了 `manifest.json` hash 也会失败。
它还会输出 `commandsShStrictCheckMissing`:如果 `commands.sh` 本身删掉 strict env 默认值、入口 `jq` 前置门禁、jq-check runner、pre/post CI check 调用或 strict artifact/proof 参数,同样不能靠自洽 manifest 通过。
`manifestStageIdMismatches` 会拒绝和当前 `plan.json` stage 顺序不一致的 `manifest.stageIds`,避免手改 manifest 隐藏、添加或重排 cutover stage。
`stagingCiExpectedReportMissing` 会拒绝漏掉当前 plan pre/post stages 应产出报告的 `staging-ci.json.expectedReports`,避免 AGS compat、staging proof、approval 或 run artifacts 被静默删掉。
`stagingCiOperatorApprovalMismatches` 会拒绝和当前 plan 审批型 mutating stage 不一致的 `operatorApprovals[]`,包括 gate id、命令、report path 和 `requires`。
`stagingCiCheckMissing` 会拒绝漏掉当前 plan 生成的 pre/post serve jq gates 的 `staging-ci.json.checks`。
`agentGitServiceCompatTargetMismatches` 会拒绝 AGS plan 中 compat stage 的 `--candidate-url` 指向不同于 `externalEnvironment.systems.controlPlane.baseUrl` 的 AGS control-plane target。
Strict external AGS compat 还会在 `candidateBaseUrl` 按 `/api/v3` 归一化后不匹配本次 staged AGS control-plane target 时拒绝 `agent-git-service-compat/manifest.json`,避免用另一个 upstream 服务冒充本次 cutover gate。
Pre-serve staging evidence 还会在 `agent-git-service-staging-readiness.json.serverReadiness` 未 ready,或其 `baseUrl` 不再匹配 `staging-targets.json.targets.controlPlane.baseUrl` 时拒绝该报告。
Final artifact verification 还会在已批准的 `agent-git-service-native-write-check.json.baseUrl` 不再匹配 staged AGS control-plane target 时拒绝该 mutating proof。
当 `agentGitServiceStaging.nativeWriteAttachmentUrl` 存在时,final artifact verification 还会要求 `agent-git-service-native-write-check.json.attachmentUrl` 匹配这条声明的 evidence URL。当 `nativeWriteWikiNote` 存在时,`staging-targets.json` 会记录它的 sha256,native-write report 必须带同一个 `wikiMemory.noteSha256`。
Strict approval verification 还会要求每个 approval run report 在 `selectedStageIds` 里包含预期 stage,并且 `executed` 里同一个 stage 必须是 `ok: true`;`platform-operator-approvals/v1` 会把错配暴露为 `stageMismatchReports` 和 `gates.allStagesExecuted`。
生成的 post-serve jq checks 还会要求最终 artifacts 本身是 strict 模式产物:`operator-artifacts.json` 必须记录 `requireExternalStaging: true`,`staging-proof.json` 必须同时记录 `requireExternalStaging: true` 和 `requireOperatorApprovals: true`,且 proof 必须 token-free、`missing`/`missingReports`/`forbiddenValueHitReports` 为空、operator artifact/post-serve/approval gates 全过,并带有 hash 锚定的 `reports.stagingCiExpectedReports`。

`serve` 跑起来以后,可以先用 `loom harness cutover-report --url <server> --tenant <tenant> --token-env <env>` 读取 server 与 tenant readiness,作为跑重型 smoke 前的只读上线摘要。它会从共享 contract 重新计算必需 golden-path 和 vision-lock capabilities,不会只信 `ok: true`;同时会校验 server 与 tenant 视角的 `server.concurrencyAdmission`,确保 active-run lease、tenant cap、queue blocker 和跨 server run-control 在 cutover 前仍然可见。带 `--control-plane-provider agent-git-service --admin-token-env <env>` 时,它还会读取 admin-only 的 AGS provisioning plan;只要 project-agent receipt/secret 还没齐就非零退出,输出 `missing`、`nextActions`、不含 token 的逐 project plan evidence,以及给 CI 用的 AGS provisioning plan/apply argv 字段。传入 `--project`、`--isolation-tenant`、viewer/admin/webhook env 名后,还会输出 `smokeCommandArgs`,方便 CI 或 operator 脚本直接复跑。

cutover 和 smoke report 都存在后,可以跑 `loom harness platform-concurrency-audit --cutover-report reports/cutover-report.json --smoke-report reports/smoke.json --require-agent-git-service --report reports/concurrency-audit.json`。bundle 的 post-serve `commands.sh` 也会自动写出并归档这份不含 token 的 `platform-concurrency-audit/v1`,把 run-scoped workspace lease、run-suffixed branch lease、多 agent smoke 证据和 AGS project-agent token 注入合成一个 gate,作为后续 AGS 并发 sandbox rollout 的机器判定。final artifacts 和 staging proof 都存在后,可以跑 `loom harness platform-goal-audit --dir cutover-bundle --require-external-staging --require-operator-approvals --require-agent-git-service --report cutover-bundle/reports/goal-audit.json`;bundle post-serve 脚本也会自动写出 `platform-goal-audit/v1`,在本地 MVP、当前严格 staging prerequisites、当前严格 `staging-run.json`、当前 `external-staging-audit.json` 以及 staging proof 对这些 pre-serve report、当前 operator artifacts、当前 operator approvals 和当前 CI proof 的 hash 锚定、strict-mode operator artifacts、operator-artifacts 对当前 pre-serve reports 与当前 cutover/smoke/concurrency/CI/cockpit-runner 执行报告的 hash 锚定、CI proof 与已审计 post-serve workflow dispatch/wait 的 run id 匹配、严格外部 staging、审批 proof、AGS provider 证据和 production cutover gate 全部为真之前保持红灯,避免 MVP 盖住最初的多用户在线沙箱目标;随后脚本会写 `operator-status.json`,作为最终 operator 可读的 `production-cutover-ready` 总览。

从 preflight 到 smoke、AGS onboarding 和 cutover 判断的最短操作流程见 [docs/operator-runbook.md](docs/operator-runbook.md)。

接真实 Coder/Gitea/LiteLLM 之前,可以先跑 `loom harness rehearsal`。它会在本进程启动本地 platform server、假 model gateway、Coder 形状的本地 executor、tenant keys 和 reporter hooks,先执行只读 cutover report,再执行完整 `platform-readiness` smoke,用最快路径反复证明多用户 sandbox、VAS-lite learning、human gates、run-scoped concurrency、metrics/probes、backup dry-run 和 control-plane comment/PR surface 仍然能组合起来。加 `--peer-server` 会再启动第二个共享同一 workspace root 的 harness server,并要求 cross-server active-run lease、pause、cancel 和 idempotent-create 证据通过。加 `--control-plane-provider agent-git-service` 可以同时排练本地 AGS candidate path:命令会启动共享的 contract-backed 本地 AGS `/api/v3` server,通过 harness admin endpoint provision 并存储 project-agent token,生成 `platform-cutover-plan`,导出并用 forbidden secret-value scan 与 sha256 manifest 验证 `.loom/operator-cutover-bundle`,再从导出的 bundle plan 执行包含 AGS compat 和 staging readiness 的 safe stages,同时在 bundle 的 `reports/` 下写出 rehearsal bundle verify、safe run、approved run、platform-preflight、AGS staging、staging-targets、cutover report 和 smoke 报告,显式批准两个 AGS mutating gate,写出 `reports/operator-approvals.json`,然后用 strict `platform-cutover-artifacts-verify` 写出 `reports/operator-artifacts.json` 和 `reports/staging-proof.json`,并在 stdout 的 `operatorArtifactSummary` (`loom-operator-artifacts/v1`) 中汇总 report hash、token-free scan、显式 doctor/model/control-plane/Coder preflight gate,以及 `preServeEvidenceOk` / `operatorApprovalsOk` / `operatorArtifactsVerifyOk` / `agentGitServiceStagingReady` 覆盖;导出的 `commands.sh` 执行任何 stage 前也会先自检 bundle 完整性,并用 `--forbid-env` 自动扫描已声明且当前已设置的 secret env 值,最后要求 AGS cutover 和 native handoff/wiki-memory projection 证据通过,且不打印 token material。

验证一个正在运行的服务:

```bash
loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke \
  --template vas-lite
```

有 tenant 鉴权时优先用 env 传 token:

```bash
LOOM_SMOKE_TOKEN=dev-secret LOOM_SMOKE_VIEWER_TOKEN=read-secret LOOM_SMOKE_ADMIN_TOKEN=admin-secret loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke \
  --token-env LOOM_SMOKE_TOKEN \
  --viewer-token-env LOOM_SMOKE_VIEWER_TOKEN \
  --admin-token-env LOOM_SMOKE_ADMIN_TOKEN \
  --isolation-tenant bob \
  --profile online-sandbox
```

`smoke` 会创建或复用 project;使用 `--template vas-lite` 时,会先检查项目 summary 里的 `contractStatus`,防止目标漂移后继续跑;随后跑一个极小的 scripted harness run,读回 summary/events,通过 workspace file API 验证 run 产物可在线读取,验证 project workspace context/executor kind,在提供 `--isolation-tenant` 时验证同一个 token 不能读取另一个 tenant 的 status,也可用 `--check-command` 验证一次性 workspace command endpoint,用 `--check-session` 验证持久 workspace session,用 `--check-vas` 验证 `vas-lite` bootstrap case、review queue、review package、一轮真实 `vas-lite-review` preset run、生成的 report/context artifacts、review-required VAS run、case approval、project learnings 和 learned-patterns 持久化,用 `--check-online` 验证 Dashboard/Workbench HTML、dashboard tenant/global readiness 标签、Dashboard AGS provisioning controls、Dashboard project concurrency controls、project/run 在线协作者 presence,以及 run comment 能进入 replay 的持久 steering 记录,用 `--check-file-collab` 验证过期 project/run workspace 文件保存/移动/删除会被拒绝且带同文件 active editor 证据,用 `--check-auth-roles` 和 `--viewer-token-env` 验证 developer/viewer 角色边界以及 viewer 可读的 tenant `readiness`/`readiness.goldenPath`/`visionLock`,用 `--check-gates` 和 `--admin-token-env` 验证 review gate 与 admin-only deployment gate,用 `--check-escalations` 和 `--admin-token-env` 验证 admin-approved policy escalation,用 `--check-handoff` 写入 project source defaults,验证 source run 和 handoff follow-up 都继承这些默认值,验证 review-summary/handoff-package 的 contract evidence、启动一次 handoff follow-up run,并验证 approved contract patch 出现在 review summary、handoff gate trail 和 replay,用 `--check-control-plane-pr` 验证控制面 PR 创建和 review-gated run 证据,用 `--check-control-plane-comments` 验证控制面 issue comment sync 能通过 `/loom approve` 推动 review-gated run;如果 smoke 带了 `--control-plane-webhook-secret-env` 或 `--gitea-webhook-secret-env`,还会签名发送一条 control-plane webhook,推动第二个 review-gated run,用 `--check-backup` 验证 admin-only tenant control-plane backup/migration manifest 和 restore dry-run,用 `--check-coder` 验证 Coder workspace context 和浏览器 IDE/preview 链接,用 `--check-run-controls` 验证 async run 的 pause/resume/cancel 控制面和 active-run workspace lease scope/key 证据;如果同时传 `--peer-url`,还会验证第二个共享 server 实例能看到同一条 active-run lease,pause/cancel 请求会从 peer 发出,并会向两个实例同时发送同一 `clientRequestId` run create,用来证明跨实例 owner-loop 投递和幂等 replay 路径;最后输出 dashboard、summary、events URL,不会把 token 打到输出里。`--profile online-sandbox` 要求 `--isolation-tenant`,会先要求 `GET /status` 报告同名服务端 profile、完整必需服务端 allowlist、覆盖 `admin`/`developer`/`viewer` 的 role-based tenant auth、Docker/Coder 沙箱 executor、持久 home 状态(Docker 需要 `--executor-home-root`)、`readiness.ok: true`、`readiness.goldenPath.ok: true` 和完整 `readiness.goldenPath`/`visionLock` 能力集合,再要求 `GET /tenants/:tenant/status` 报告该 tenant 的 effective 必需 allowlist、匹配的 `readiness.ok: true`、匹配的 `readiness.goldenPath.ok: true` 和同样完整的 `visionLock` 目标/能力集合,然后打开这些在线沙箱检查:`--check-command`、`--check-session`、`--check-vas`、`--check-online`、`--check-file-collab`、`--check-auth-roles`、`--check-gates`、`--check-escalations`、`--check-handoff` 和 `--check-run-controls`。`--profile platform-readiness` 同样要求 `--isolation-tenant`,会打开同一组检查,再额外打开 `--check-brain`、`--check-model`、`--check-control-plane-pr`、`--check-control-plane-comments`、`--check-backup` 和 `--check-coder`;它的 status readiness 要求在线沙箱 executor/home/role-auth 检查、model base URL 加全局、tenant 或 policy model key env、PR reporter、control-plane issue URL 证据链接、workspace Git transport/PR handoff、tenant-scoped control-plane agent identity、issue comment sync、signed webhook 配置、brain ingest、`executorKind: "coder"` 和同一套 `readiness.goldenPath`/`visionLock` guard。platform-readiness smoke 应传入同一个 webhook secret env,这样会主动验证 signed webhook push,而不是只看 server readiness。profile smoke 成功输出会包含 server/tenant/viewer golden-path 字段、`dashboardAgentGitServiceProvisioningChecked`、`dashboardProjectConcurrencyChecked`、`onlineSandboxGoldenPathChecked`、`onlineSandboxGoldenPathProfile`、`onlineSandboxGoldenPathCapabilities`、`sourceDefaultsChecked`、`handoffFollowupSourceDefaultsChecked`、`runScopedFileWriteDuringActiveRunChecked`、`activeRunLeaseChecked`、`activeRunLeaseScope`、`activeRunLeaseKey`、`controlPlaneCommentsWebhookChecked`、`backupManifestChecked` 和 `backupRestoreDryRunChecked`,方便 CI 一次性断言 multi-user isolation、online workspace、harness loop、source-default handoff、signed control-plane push、backup/migration manifest、VAS learning、human gate、AGS project-agent operator entrypoint、project-concurrency operator entrypoint 和 run-control 路径没有被 MVP 切掉。`--check-command`、`--check-session` 和 `--check-run-controls` 都要求 effective allowlist 包含 `shell.exec`;`--check-handoff` 要求 effective allowlist 包含 `git.diff`;只对用 `--allow-shell` 或等价显式 allowlist 启动的隔离沙箱使用。`--check-vas` 要求 `--template vas-lite`。

`platform-readiness` 也要求 run-scoped workspace isolation:server 和 tenant status 都必须暴露 `server.runWorkspaceIsolation: "run"` 与 `readiness.checks.runWorkspaceIsolation.ok: true`;`readiness.checks.controlPlaneWorkspaceBranchLease.ok` 还必须证明 provider-neutral workspace branch lease seam 存在。成功 profile smoke 会同时校验 server/tenant status 的 provider catalog `adoptionStages`,并输出 `healthProbesChecked`、`readyzReady`、`healthProbesSensitiveFieldsAbsent`、`metricsChecked`、`metricsReady`、`metricsLowCardinalityChecked`、`metricsSensitiveLabelsAbsent`、`serverRunWorkspaceIsolation`、`tenantRunWorkspaceIsolation`、`serverControlPlaneApiBasePath`、`serverControlPlaneDiscoveryEndpoints`、`serverControlPlaneDiscovery*`、`serverControlPlaneNativeCapabilities`、`serverControlPlaneAdoptionStages`、`serverControlPlaneGatedAdoptionStages`、`serverControlPlaneTenantDefaultCutoverGated`、`tenantControlPlaneProvider`、`tenantControlPlaneAdoptionStages`、`tenantControlPlaneGatedAdoptionStages`、`tenantControlPlaneDiscovery*`、`tenantControlPlaneTenantDefaultCutoverGated`、`activeRunLeaseChecked`、`activeRunLeaseScope`、`activeRunLeaseKey`、`controlPlaneWorkspaceBranchLeaseChecked`、`controlPlaneWorkspaceBranchLeaseProvider`、`controlPlaneWorkspaceBranchLeaseBranchDerivation`、`runScopedFileWriteDuringActiveRunChecked`、`runScopedPullRequestDuringActiveRunChecked` 和派生 branch 证据;其中 control-plane discovery 输出会携带不含 token 的 `tokenMode`、tenant 计数和缺失 tenant 列表,`cutover-report` 也会把这些字段带进上线摘要。如果 tenant-visible provider 和 server status 漂移,会以 `SMOKE_TENANT_CONTROL_PLANE_PROVIDER_MISMATCH` 失败。这样 CI 能发现匿名 health/readiness probe 退化或泄露 status-only 字段、metrics 退化为高基数或泄露租户/项目/run 细节、退回 project-level lock、active-run lease 拓扑不可见、workspace branch lease seam 消失、AGS runtime discovery probe、AGS 原生 capability seam 或 tenant-visible gated adoption path 消失、同一个 active run 的文件写入没有被串行化、已完成 run 的 PR handoff 被另一个 active isolated run 误挡,或默认分支被并发 run 复用的问题;同时 tenant status 的 AGS cutover readiness 不会泄露另一个 tenant 的 missing project-agent 状态。
Multi-agent concurrency smoke 更新,2026-07-01: platform-readiness 现在会在这些分散的 lease/file/PR 检查组成完整并发契约后输出 `multiAgentConcurrencyChecked`。结果里包含 `multiAgentConcurrencyIsolation`、`multiAgentConcurrencyActiveRunLeaseChecked`、`multiAgentConcurrencyRunScopedFileWriteChecked`、`multiAgentConcurrencyRunScopedPrHandoffChecked` 和 `multiAgentConcurrencyBranch`,并会在 `onlineSandboxGoldenPathCapabilities` 里追加 `multi-agent-concurrency`;如果 smoke 带 `--peer-url`,这个聚合证据还要求 cross-server active-run lease 和 `clientRequestId` replay 也成立。

成功 smoke 输出会同时保留旧的 `gitea*` 兼容字段,并新增 provider-neutral 的 `controlPlanePr*` 与 `controlPlaneComments*` 字段;CI 后续应优先断言后者,避免把 adapter seam 绑死在 Gitea/Forgejo 名称上。

Metrics smoke 还会输出 `metricsReviewRequiredRuns`、`metricsDeploymentRequiredRuns`、`metricsModelUsageWarningProjects` 和 `metricsWorkspaceUsageWarningProjects`,让 CI 能在不引入 tenant/project/run label 的情况下观察 gate backlog 和资源 warning 压力。启用 `--check-gates` 且 metrics 打开时,smoke 会在 review/deployment gate 仍处于 pending 状态时记录 `reviewGateMetricsChecked` 和 `deploymentGateMetricsChecked`。启用 `--check-model`、metrics 打开且有 admin token 时,smoke 会在模型 run 后压低 warning 阈值,等 `/metrics` 和 tenant warning queues 报告非零 warning 压力后记录 `modelWarningMetricsChecked`、`modelWarningQueueChecked`、`workspaceWarningMetricsChecked` 和 `workspaceWarningQueueChecked`;随后还会从这些 warning queues 创建带 warning source 的 policy escalation 请求,并记录 `modelWarningEscalationChecked`、`workspaceWarningEscalationChecked` 和 `warningEscalationAuditChecked`。

启用 `--check-backup` 时,成功 smoke 输出还会包含 `backupRestoreDryRunAuditChecked`,表示已经读回 restore dry-run 的 tenant audit 证据;当 dry-run 目标是 `agent-git-service` 时,还会输出 `backupRestoreDryRunCutoverReady` 和 `backupRestoreDryRunAgentGitServiceProjectAgents*` receipt/secret readiness 字段。

`loom harness doctor --profile platform-readiness` 会在 `serve` 前检查同一批前置条件:合法端口、timeout、session/run limit 和 executor resource flags;executor 必填 flags,例如 Docker `--executor-image` 或 Coder `--executor-workspace`;Coder executor/worktree 模式、model key env、CLI env-name 或 policy-backed role-based tenant keys、control-plane PR/comment/webhook/merge flags、`git.pr`、workspace branch lease 证据、tenant-scoped control-plane token envs、webhook secret env 和 brain ingest。缺失 env 和已配置的 control-plane token readiness 都只报告 env 名,不会输出 token/secret 值;`checks.controlPlaneEnvValidation` 会包含 `tokenMode`、shared `tokenEnv` 或 tenant-scoped `tenantTokenEnvNames`,`checks.controlPlaneWorkspaceBranchLease` 会包含 provider、run isolation、run-suffixed branch derivation 和 active-run lease evidence,方便 CI 断言。它的 JSON 也会带上共享 `visionLock`、provider-neutral `controlPlane.boundary`、provider catalog 的 `apiBasePath`/`discoveryEndpoints`/`nativeCapabilities`/`adoptionStages` 和 online-sandbox `goldenPath`,让 CI 能断言预检仍然守住长期的多用户 harness-loop 目标和后续 provider adapter 边界。

如果 `--check-online` 因 dashboard readiness 标签缺失而失败,stderr 会带 `SMOKE_ONLINE_READINESS_LABELS_MISSING`,并在 JSON `details` 里列出 expected/missing labels。同一个检查也会守住在线 surface 里的 brain feed 入口和一次性 query-token 登录;Dashboard 或 Workbench 缺少 brain feed 标记时会输出 `SMOKE_ONLINE_BRAIN_UI_MISSING`,缺少 token scrub 标记时会输出 `SMOKE_ONLINE_TOKEN_SCRUB_MISSING`。
Profile readiness 失败也使用同一格式:server profile 不匹配会输出 `SMOKE_SERVER_PROFILE_MISMATCH`,server readiness 缺口会输出 `SMOKE_SERVER_READINESS_MISSING`,tenant readiness 缺口会输出 `SMOKE_TENANT_READINESS_MISSING`,readiness profile 不匹配会输出 `*_READINESS_PROFILE_MISMATCH`。
Platform run isolation 失败会输出 `SMOKE_SERVER_RUN_WORKSPACE_ISOLATION_REQUIRED` 或 `SMOKE_TENANT_RUN_WORKSPACE_ISOLATION_REQUIRED`;status 字段值非法时输出 `*_RUN_WORKSPACE_ISOLATION_INVALID`。
Profile golden-path 失败会在 `--profile` 缺少 `--isolation-tenant` 时输出 `SMOKE_PROFILE_ISOLATION_TENANT_MISSING`;status `readiness.goldenPath` 缺失或不完整时输出 `SMOKE_SERVER_GOLDEN_PATH_MISSING` 或 `SMOKE_TENANT_GOLDEN_PATH_MISSING`;其数组 schema 无效时输出 `SMOKE_SERVER_GOLDEN_PATH_INVALID` 或 `SMOKE_TENANT_GOLDEN_PATH_INVALID`;必需 profile capability 没有被实际跑到时输出 `SMOKE_ONLINE_SANDBOX_GOLDEN_PATH_MISSING`。
Profile tool allowlist 失败会输出 `SMOKE_SERVER_TOOLS_MISSING` 或 `SMOKE_TENANT_TOOLS_MISSING`,并在 JSON `details.missingTools` 和 `details.requiredTools` 里给出工具差异。
Profile 数组 schema 无效时会输出 `SMOKE_SERVER_TOOLS_INVALID`、`SMOKE_TENANT_TOOLS_INVALID`、`SMOKE_SERVER_READINESS_INVALID`、`SMOKE_TENANT_READINESS_INVALID`、`SMOKE_VISION_LOCK_CAPABILITIES_INVALID` 或 `SMOKE_TENANT_VISION_LOCK_CAPABILITIES_INVALID`,并在 JSON `details.field` 和 `details.invalidItems` 里指出字段和非法项。
Vision lock 漂移在 server status 会输出 `SMOKE_VISION_LOCK_TARGET_MISMATCH`、`SMOKE_VISION_LOCK_SCOPE_REDUCTION` 或 `SMOKE_VISION_LOCK_CAPABILITIES_MISSING`,在 tenant status 会输出 `SMOKE_TENANT_VISION_LOCK_MISSING`、`SMOKE_TENANT_VISION_LOCK_TARGET_MISMATCH`、`SMOKE_TENANT_VISION_LOCK_SCOPE_REDUCTION` 或 `SMOKE_TENANT_VISION_LOCK_CAPABILITIES_MISSING`,并在 JSON details 里给出 `actualTarget`、`mvpIsScopeReduction` 或 `missingCapabilities`,让长期 multi-user online sandbox 目标持续进入 smoke 自动化。
`vas-lite` project contract 漂移会输出 `SMOKE_PROJECT_CONTRACT_DRIFT`;如果 `contractStatus.missing` 不是字符串数组,会输出 `SMOKE_PROJECT_CONTRACT_INVALID`。
Handoff contract evidence 漂移会输出 `SMOKE_HANDOFF_CONTRACT_DRIFT`;handoff contract 或 contract-patch 数组 schema 无效时会输出 `SMOKE_HANDOFF_CONTRACT_INVALID` 或 `SMOKE_HANDOFF_CONTRACT_PATCH_INVALID`。
Brain readiness 漂移会在 completed-run ingest 没有写入 run external-effect 或 audit 证据时输出 `SMOKE_BRAIN_RUN_INGEST_MISSING`;tenant brain feed 不能同时展示 completed-run 和 workspace signal 证据时输出 `SMOKE_BRAIN_SIGNAL_FEED_MISSING`。
Auth role smoke 失败会在 `--check-auth-roles` 缺少 viewer token 时输出 `SMOKE_AUTH_VIEWER_TOKEN_MISSING`,在 viewer token 实际返回非 viewer 角色时输出 `SMOKE_AUTH_VIEWER_ROLE_MISMATCH`,在 viewer 可读 tenant status 报告 readiness 缺口时输出 `SMOKE_AUTH_VIEWER_READINESS_MISSING`,在 viewer 可读 `readiness.goldenPath` 缺失、不完整或 schema 无效时输出 `SMOKE_AUTH_VIEWER_GOLDEN_PATH_MISSING` 或 `SMOKE_AUTH_VIEWER_GOLDEN_PATH_INVALID`,在 viewer 可读 vision target 漂移时输出 `SMOKE_AUTH_VIEWER_VISION_LOCK_TARGET_MISMATCH`,在其报告 MVP 属于 scope reduction 时输出 `SMOKE_AUTH_VIEWER_VISION_LOCK_SCOPE_REDUCTION`,在缺少必需 vision capability 时输出 `SMOKE_AUTH_VIEWER_VISION_LOCK_CAPABILITIES_MISSING`。

`--check-brain` 是显式的 M3/brain readiness 检查:它会先确认 smoke run 本身产生了 completed-run `brain_ingest` external-effect 和 tenant audit 证据,再向 `POST /tenants/:tenant/brain/signals` 发送一条 Stop-hook 风格的 `RunSignal`,验证响应和 tenant audit 事件,随后读取 `GET /tenants/:tenant/brain/signals?project=<project>`,证明 tenant 有一个 viewer 可读的 brain feed,且同时包含 completed-run 与 workspace signal 两种来源。服务端需要用 `--ingest-brain` 启动。

`--check-model` 是显式的 LiteLLM/OpenAI-compatible model readiness 检查:它会通过服务端配置的默认模型启动一次 model-backed run,验证生成产物、model usage 计量,并确认 replay 里包含 `model_usage`。服务端需要用 `--model-base-url` 和模型/API key 配置启动。

`--check-control-plane-pr` 是显式的 provider-neutral PR readiness 检查:它会启动一个带 `pullRequest: true` 的 review-gated run,验证已创建 PR 的 metadata,确认 run events 里有 `pull_request` external effect,并输出 `controlPlanePr*` smoke 字段。传 `--control-plane-provider <provider>` 后,如果实际 PR evidence 来自另一个 provider,smoke 会用 `SMOKE_CONTROL_PLANE_PROVIDER_MISMATCH` 失败。服务端需要通过 `--control-plane-pr` 启用对应 provider 的 PR reporter;默认 Gitea/Forgejo provider 仍接受 `--gitea-pr` 兼容别名。`--check-gitea-pr` 仍作为兼容别名可用。

`--check-control-plane-comments` 是显式的 provider-neutral issue-comment 控制面检查:它会启动一个 linked issue 的 review-gated run,同步 issue comments,验证 `/loom approve` 评论能把 review gate 推到 `passed`,并确认 replay 与 audit 证据,同时输出 `controlPlaneComments*` smoke 字段。如果 smoke 传了 `--control-plane-webhook-secret-env` 或 `--gitea-webhook-secret-env`,它还会启动第二个 review-gated run,向 `POST /tenants/:tenant/webhooks/control-plane/issue-comments` 发送不带 provider query override 的签名 payload,验证 webhook-driven review、audit evidence 和 `controlPlaneCommentsWebhook*` 字段。传 `--control-plane-provider <provider>` 后,issue-comment audit evidence 也必须匹配该 provider。Platform readiness 要求 signed issue-comment webhook 配置,也应该把同一个 secret env 传给 smoke,让共享控制面评论既能被 smoke 触发同步,也能通过持久 push 进入 harness log。服务端需要通过 `--control-plane-comment-sync` 启用 issue-comment sync;默认 Gitea/Forgejo provider 仍接受 `--gitea-webhook-secret-env` 和 `--gitea-comment-sync` 兼容别名。`--check-gitea-comments` 仍作为兼容别名可用。

`--check-backup` 会验证 admin-only tenant control-plane backup/migration manifest 和 restore dry-run。它会读取 `GET /tenants/:tenant/control-plane/backup`,检查 provider-neutral boundary 覆盖完整 control-plane 边界,确认 project/run/audit checkpoint 存在,再把同一份 manifest POST 到 `POST /tenants/:tenant/control-plane/restore-dry-run?targetProvider=<另一个可 serve provider>`,确认 dry-run 有效且不会写入状态,验证 source/target provider 证据和 restore dry-run audit event,并在 JSON 里出现已知 smoke token 或 token hash 时失败。传 `--control-plane-provider <provider>` 后,backup manifest 的 source provider 也必须匹配这个期望。target provider 会选当前 source 之外的另一个 serve-enabled provider,所以默认 Gitea/Forgejo smoke 会 dry-run 到 `agent-git-service`,而 `--control-plane-provider agent-git-service` smoke 会 dry-run 回 `gitea-forgejo`;目标是 AGS 的 dry-run 还会返回非 secret 的 `cutoverReadiness.stage: "tenant-default-cutover"` 和逐 project receipt/secret readiness。它要求 `--admin-token` 或 `--admin-token-env`。

`--check-agent-git-service-cutover` 会在 AGS project-agent provisioning 之后做 cutover rehearsal。它读取不含 token 的 provisioning receipt,校验 AGS provider 和 tenant/project ref,再跑一个 workspace command,只检查 receipt 里的 `tokenEnvName` 是否已经出现在 executor environment。成功输出包含 `agentGitServiceCutover*` 字段、`agentGitServiceCutoverReceiptSecretAbsent: true` 和固定的 `agent-git-service-cutover-token-ok` 标记,不会输出已存 token。`--profile platform-readiness --control-plane-provider agent-git-service` 会自动启用这个 rehearsal,并在 smoke 结果的 `onlineSandboxGoldenPathCapabilities` 里追加 `agent-git-service-cutover`。

`--check-coder` 是显式的 Coder workspace readiness 检查:它会验证 project/run 两个 workspace context 都报告 `executor.kind: "coder"`,并暴露浏览器 IDE 和 preview URL。服务端需要用 `--executor coder`、`--executor-workspace` 和 `--executor-ide-url`/`--executor-preview-url` 启动。

打开 dashboard:

```text
http://127.0.0.1:8787/
```

Dashboard URL 也可以预填 tenant/project 或选中的 run,例如 `http://127.0.0.1:8787/?tenant=alice&project=default` 或 `http://127.0.0.1:8787/?tenant=alice&project=default&runId=<runId>`。浏览器流程里不方便手动输入 API key 时也接受 `token` query 参数;Dashboard 和 Workbench 会导入它、从浏览器地址栏清掉它,并生成不带 token 的跳转链接。

Dashboard 可以创建空 tenant project 或 seed `vas-lite` 项目骨架,保存项目级 repo/branch/baseBranch/issue 默认值、默认 skills、默认 run policy 和 project contract,显示 project-level VAS readiness 与 contract health、带 token/cost budget escalation 预填的模型用量 warning 队列、带 workspace quota escalation 预填的 workspace 用量 warning 队列、在线协作者焦点、带 project-card Open 操作的 active project/run session 细节、最近 project/run command/session 和 workspace change 摘要、queued backlog 操作入口,列出/创建/复核 VAS case,加载 project-level VAS review queue 和 VAS case review package,对 VAS review queue 工作做 claim/release 作为可见 reviewer 信号,启动 local/model-backed 或 preset-backed run,设置单次 run 的允许工具,填写 verification/evaluator command,填写 repo/branch/issue 元数据,请求创建 PR,要求人审,要求部署审批,取消 running/queued run,恢复 paused run,对 pending run review 做 claim/release,审批或拒绝 review-gated run,审批或拒绝 deployment-gated run,打开 run workbench,加载可读 run replay、按 seq 去重并用浏览器原生重连保持选中 run event stream、发送进入 replay/audit 的 run comment、同步 linked issue comment 并显示 pause/resume/review/VAS/handoff follow-up command outcome、为 running run 请求当前 step 后暂停、review summary 和 handoff package,也能从选中的 handoff package 启动 follow-up run,并申请/由 admin 审批 tenant policy escalation。它也会显示 run requester 身份、带当前焦点且会同步刷新 project list 在线汇总的 project collaborator presence、随 heartbeat 刷新、上卷到 project card 且可 Open 的 run workbench collaborator presence、文件编辑器里的同文件协作者提示、run list、summary 和已加载 lineage 里的 follow-up source Workbench/package 链接及随 audit 刷新的 child 状态、server 限制、profile readiness 和 golden path readiness,以及全局/当前 tenant 资源和队列健康状态、run list 里的逐 run 排队 tenant/project 位置和阻塞原因、project list 里的 queued run id/Workbench/Cancel 操作和 review/deploy backlog run id/goal/claim/Workbench 操作,展示当前 project/run 的 workspace executor 上下文和有界 git diff,加载当前 tenant audit feed 并按 seq 去重后把 policy/member 变更渲染成可读摘要、policy 和 escalation request,让 admin 保存不含 token 的 policy settings、模型 token/cost warning/hard limit 和 workspace byte warning/hard limit,可以浏览/新建/编辑/移动/删除 workspace 文件,创建 git checkpoint,用 run metadata 或 project source defaults 发起 workspace PR handoff,或为 PR handoff 申请 `git.pr` escalation,运行允许的 workspace command,重新打开 command history,重新打开带 transcript seq 续流 SSE 的持久 terminal session transcript,并在匹配的 project audit event 到达时静默刷新 project summary/backlog、模型/workspace 用量 warning 队列以及 VAS/run/diff/当前目录 file/command/session 视图,且不清掉当前 workspace 错误提示、不覆盖正在编辑的 VAS review draft。

Dashboard 选中的 run 收到匹配的 gate/control、PR handoff、comment、issue sync 或 follow-up lineage audit event 时,会静默刷新该 run 的 event list、replay、已加载的 review summary、已加载的 handoff package 和已加载的 follow-up lineage,包括 child run 状态变化,避免另一位用户操作后 timeline 停在旧版本,也避免临时刷新失败清掉已加载 replay 或 lineage。

Dashboard 选中 run 的 `harness_event` live stream 收到新事件时,已打开的 replay panel 会静默刷新;收到 `finish` 后,已加载的 review summary 和 handoff package 也会静默刷新。

Run-scoped workspace PR handoff 也可以在 run 已经 passed 后追加 review/deployment gate。

Dashboard 的 Server 面板可以加载当前 project 的 brain signal feed;匹配的 brain ingest audit 到达时会静默刷新。

直接打开某个 run 的 focused workbench:

```text
http://127.0.0.1:8787/workbench?tenant=alice&project=default&runId=<runId>
```

Focused workbench 也有 run-scoped brain 面板,reviewer 不必翻完整 tenant audit stream,就能看到该 run 的 completed-run 与 workspace-signal 证据。

Workbench 是 run-scoped 的在线沙箱界面,包含 summary、requester 身份、当前 actor/role/auth 模式、queued run tenant/project 位置和阻塞原因、review summary、带 changed-file/command/session 打开入口的 handoff package、带子 run 反向 source Workbench/package 链接且随 audit 刷新 child 状态的 follow-up lineage、handoff follow-up run 启动、run review claim/release、run review approve/reject、admin deployment approve/reject、VAS Lite review draft artifacts、case review package、case claim/release、case review、带 PR/gate/artifact evidence 的 case run history、从当前 case 启动下一轮 review run、可见 workspace/executor 上下文和有界 git diff、executor 暴露时可点击的浏览器 IDE 链接、带文件、review summary、handoff package、VAS case、command 和 session 当前焦点的短 TTL collaborator presence、同文件协作者提示、带 assistant plan/detail 的 replay、按 seq 去重并静默保持 running/queued run replay 新鲜的实时 run event、finish 时静默刷新 run summary 和已加载的 review summary/handoff package、run comment、pause request、running/queued run cancel、重启后 orphaned run abandon fallback 和 resume、按 seq 去重且包含已加载 follow-up child 事件的实时 audit;child 事件只刷新已加载 follow-up lineage,不会把 child workspace activity 当作 source run activity,并会静默刷新匹配的当前 run summary/replay/review-summary/handoff-package/VAS/diff/file/command/session 和 handoff-followup,且不清空当前 command error,也不会在临时失败时替换已加载的 replay、review summary/handoff package 面板或 follow-up lineage、带版本检查和 reload-latest 冲突恢复的文件浏览/新建/编辑/移动/删除、command history、一次性 command、可按已加载 transcript seq 续流的持久 terminal session、保留当前上下文的 Dashboard 链接,以及面向 PR handoff 的 `git.pr` escalation 申请。它会先加载当前 tenant role 再启用可变更控件,并复用同一套 tenant auth、executor 边界和 `shell.exec` policy;developer/admin 可以取消、abandon 或恢复 run、处理 review gate, deployment gate 仍然要求 admin。

Workbench 的 PR handoff 控件包含 review/deployment gate 开关。

多人/在线使用时要求 role-based tenant API key:

```bash
loom harness serve \
  --workspace-root /tmp/loom-workspaces \
  --port 8787 \
  --profile online-sandbox \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --executor-home-root /var/lib/loom-homes \
  --tenant-model-key alice=LOOM_ALICE_MODEL_KEY \
  --tenant-key-env alice=LOOM_ALICE_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_ALICE_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_ALICE_VIEWER_TOKEN:auditor:viewer
```

在 dashboard 里填 API key,或者 API 请求带 header:

```bash
curl -s http://127.0.0.1:8787/tenants/alice/runs \
  -H 'authorization: Bearer dev-secret'
```

`--tenant-token alice=dev-secret` 仍然兼容,等价于一个没有命名 actor 的 admin token。共享服务更推荐 `--tenant-key-env tenant=ENV:actor:role`;`--tenant-key tenant=token:actor:role` 仍可用于本地或生成脚本。role 可以是 `admin`、`developer` 或 `viewer`。

`online-sandbox` 和 `platform-readiness` 会把 CLI bootstrap `--tenant-key-env`/`--tenant-key` 与 policy-backed `apiKeys` 都计入必需的 `admin`/`developer`/`viewer` readiness 角色。Legacy `--tenant-token` 仍可兼容使用,但不会让共享沙箱 profile 变成 ready。

`--tenant-model-key tenant=ENV_NAME` 会让该 tenant 的 model-backed run 使用 `process.env[ENV_NAME]` 作为 LiteLLM/OpenAI-compatible key。Tenant policy 里也可以写 `"modelKeyEnv": "ENV_NAME"`;API 只返回 env 名,不会返回 key 值。Policy `apiKeys` 里的单个 key 也可以写 `"modelKeyEnv": "LOOM_USER_MODEL_KEY"`,它优先于 tenant 级 `modelKeyEnv`,用于同一 tenant 内按人路由到不同 LiteLLM virtual key。Tenant policy 也可以写 `"executorTemplateParameters": ["auth_mode=subscription", "owner={tenant}"]`;这些是非 secret 的 Coder 创建参数,会在 CLI 默认模板参数之后、资源限制覆盖之前生效。
Platform readiness 接受服务端全局 model key、覆盖已配置 tenant 的 tenant-scoped model env,也接受 policy API-key scoped model env;status 和 doctor 只暴露 `keyMode`(`server`、`tenant-scoped`、`policy-key-scoped` 或 `mixed`)、tenant 数量和缺失 env 名,不会输出 key 值。

完整密钥轮换用 `PUT /tenants/:tenant/policy`,因为它会写入包含 `apiKeys` 和非 secret `controlPlaneIdentities` 的完整 policy;传入的明文 `token` 会以 `tokenHash` 落盘,并在 tenant audit 里记录非 secret 的 `policyChange` before/after 证据。`controlPlaneIdentities` 用 `{ provider, externalActor }` 把签名 control-plane 评论作者映射成租户内 `{ actor, role }`,映射后的 `/loom` review/deploy/VAS/handoff 命令按该租户 role 授权,同时保留 `controlPlaneExternalActor` 外部证据。Dashboard 和常规 admin 配额调整用 `POST /tenants/:tenant/policy/settings`;它只更新 `modelKeyEnv`、`executorTemplateParameters`、`limits`、`allowedTools`,会保留已有 API key hash 和 `controlPlaneIdentities`,并记录 settings 范围的非 secret `policyChange` 形状。模型 token/cost warning limits 会在 project summary 里产生模型用量 warning,也能通过 `GET /tenants/:tenant/model-usage/warnings` 拉取当前 warning project 队列,但不会阻断 run;Dashboard 可以从该队列预填 token/cost budget escalation,再由用户提交、admin 审批,并把 `source.kind=model_usage_warning`、project 和 detail 写入 escalation/audit。模型 token/cost hard limits 会在当前 project/requester 聚合 token 或 cost 已达到或超过配置值时,拒绝新的 model-backed run 创建、queued run 启动和 paused run resume。Paused run resume 的预算检查归原始 run requester,但 `resume` 事件和 tenant audit 仍记录执行恢复的 developer。`limits.workspaceByteWarning` 会在 project summary 里产生 workspace 用量 warning,也能通过 `GET /tenants/:tenant/workspace-usage/warnings` 拉取当前 warning project 队列,但不会阻断工作;Dashboard 可以从该队列预填 workspace quota escalation,Project Concurrency board 也可以在 queued run 被 tenant run cap 卡住时预填 run-slot escalation,再由用户提交、admin 审批,并记录 `source.kind=workspace_usage_warning` 或 `source.kind=run_slot_pressure`。审批通过的 escalation 还会记录 `policyChange` 的 tools/limits before/after 证据。`limits.maxWorkspaceBytes` 会限制非 `.loom` workspace 文件内容:HTTP 文件写入会精确按替换后的大小拒绝超限,workspace command/session 在当前用量已达到或超过上限时会拒绝启动;不可信 shell 负载仍应在 Docker/Coder 层配真实文件系统配额。`allowedTools: null` 表示清除 tenant override,重新继承 server allowlist。

新增/撤销成员不要让浏览器 round-trip 旧 token:用 `POST /tenants/:tenant/policy/api-keys` 创建 policy-backed key,不传 `token` 时会生成一个 `loom_...` token 并只返回这一次;policy 文件只保存 `tokenHash`,审计里只记录 token-free 的 `createdApiKey` 和 `apiKeysBefore/apiKeysAfter` 成员证据。旧 policy 文件里的明文 `token` 仍可用,下一次写 policy 时会改写成 hash。可同时传 `modelKeyEnv` 绑定该成员的模型网关 env 名。用 `POST /tenants/:tenant/policy/api-keys/revoke` 按 `actor` 和可选 `role` 撤销,审计里记录 token-free 的 `revokedApiKeys` 和同样的成员 before/after。`--tenant-key-env`/`--tenant-key` 配置出来的 bootstrap key 仍属于服务端配置,不是 policy key。

跨域客户端可以用 `authorization: Bearer ...` 或 `x-loom-tenant-token`; CORS 预检也允许浏览器 SSE 重连会用到的 `last-event-id`。

创建一个租户 run:

```bash
curl -s http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{
    "tenant": "alice",
    "goal": "create hello.txt",
    "allowedTools": ["file.read", "file.write", "git.diff", "git.commit", "verify.run"],
    "script": [
      {
        "message": "write file",
        "actions": [
          {
            "toolName": "file.write",
            "input": { "path": "hello.txt", "content": "hello\n" }
          }
        ]
      },
      { "message": "finish", "finish": true }
    ],
    "verify": ["test -f hello.txt"],
    "skills": ["coding"]
  }'
```

读取 run:

```bash
curl -s http://127.0.0.1:8787/status
curl -s -X POST http://127.0.0.1:8787/tenants/alice/projects \
  -H 'content-type: application/json' \
  -d '{"project":"proj-a","template":"vas-lite","repo":"team/proj-a","branch":"vas/segment-001","baseBranch":"main","issue":"team/proj-a#123"}'
curl -s -X POST http://127.0.0.1:8787/tenants/alice/projects/proj-a/vas/cases \
  -H 'content-type: application/json' \
  -d '{"caseId":"segment-001","source":{"kind":"video","url":"clip://segment-001","range":{"start":0,"end":8}}}'
curl -s -X POST http://127.0.0.1:8787/tenants/alice/projects/proj-a/vas/cases/segment-001/review-runs \
  -H 'content-type: application/json' \
  -d '{"clientId":"api"}'
curl -s -X POST http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{"tenant":"alice","project":"proj-a","preset":"vas-lite-review"}'
curl -s -X POST http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{"tenant":"alice","project":"proj-a","preset":"vas-lite-review","presetInput":{"caseId":"bootstrap"}}'
curl -s http://127.0.0.1:8787/tenants/alice/projects
curl -s http://127.0.0.1:8787/tenants/alice/model-usage/warnings
curl -s http://127.0.0.1:8787/tenants/alice/workspace-usage/warnings
curl -s http://127.0.0.1:8787/tenants/alice/projects/default/workspace
curl -s 'http://127.0.0.1:8787/tenants/alice/projects/default/files'
curl -s 'http://127.0.0.1:8787/tenants/alice/projects/default/files?path=hello.txt'
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/projects/default/files' \
  -H 'content-type: application/json' \
  -d '{"path":"hello.txt","content":"edited from dashboard\n"}'
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/projects/default/commands' \
  -H 'content-type: application/json' \
  -d '{"command":"pwd && ls"}'
curl -s 'http://127.0.0.1:8787/tenants/alice/projects/default/commands'
curl -s http://127.0.0.1:8787/tenants/alice/runs
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/workspace?project=default'
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>/events
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>/replay
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/review-summary?project=default'
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/handoff-package?project=default'
```

长任务用异步 run:

如果 run 需要 `shell.exec` action,启动服务时选择隔离 executor 并显式加 `--allow-shell`:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787 \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --allow-shell
```

共享沙箱服务要显式调 active run 和 session 边界:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787 --allow-shell \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --max-tenant-active-runs 2 \
  --workspace-command-timeout-ms 120000 \
  --max-workspace-sessions 32 \
  --max-tenant-workspace-sessions 8 \
  --workspace-session-idle-timeout-ms 1800000
```

Active run admission 还会在 `.loom/runs/.admission` 写入带 lease 的 project claim;配置了 `--max-tenant-active-runs` 时,也会在 `<tenant>/.loom/admission/active-runs` 写入 tenant 级 active-run claim。Workspace session admission 会在 `.loom/admission/workspace-sessions` 写入 workspace-root 级 active-session claim,并在 `<tenant>/.loom/admission/workspace-sessions` 写入 tenant 级 active-session claim。所以多个 server 实例共享同一个 workspace root 时,不会在 running status 文件可见前同时抢到同一个 project slot,不会突破单 tenant run 总并发上限,也不会突破全局或单 tenant workspace-session cap。Project session list 和 project summary 也会用这些 claim 把远端实例中的 running session 显示为 active;server/tenant status 的 active-run 计数、queued-run blocker 以及 abandon/auto-abandon 判定也用 live active-run claim 对齐跨实例视图;没有 live claim 的持久 running session 或 run summary 才会保留为 orphaned。Project summary/detail 还会暴露非 secret 的 `concurrency` 汇总,包含 `state: "active" | "queued" | "contended"`、active run/session/collaborator 数、active run lease 详情、queued run 数和最新 workspace conflict 提示;Dashboard project card 和 Project Concurrency board 会把它渲染成统一的多用户/多 agent 争用状态,并为 active-run lease holder 提供 Open、Pause 和 Cancel 操作,也能在 queued run 被 tenant cap 卡住时预填 run-slot escalation。`loom harness smoke --check-run-controls` 会在 active run 期间断言这条 lease 拓扑;peer smoke 还会断言第二个 server 实例能看到同一条 lease。

HTTP 租户 run 也可以挂到 Docker executor:

```bash
loom harness serve \
  --workspace-root /tmp/loom-workspaces \
  --port 8787 \
  --profile online-sandbox \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --executor-home-root /var/lib/loom-homes \
  --tenant-key-env alice=LOOM_ALICE_ADMIN_TOKEN:ops:admin \
  --tenant-key-env alice=LOOM_ALICE_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_ALICE_VIEWER_TOKEN:auditor:viewer
```

HTTP 租户也可以映射到 Coder workspaces。模板支持 `{tenant}`、`{project}`、`{cwdBase}`、`{runId}`。缺失 workspace 由 `--executor-template` 创建时,`--executor-template-param name=value` 会传给 `coder create --parameter name=value`;可重复传 `auth_mode`、`cpus`、`memory_gb`、`pids_limit` 等 Coder rich parameter。Tenant policy 的 `executorTemplateParameters` 会在 CLI 模板参数之后合并,所以 `auth_mode=subscription` 这类租户值可以覆盖服务端默认值。`--executor-cpus`、`--executor-memory`、`--executor-pids-limit` 以及 tenant policy executor limits 会覆盖同名 Coder 资源参数,并且创建时会非交互使用参数默认值。Coder workspace 和 template 名如果像 CLI flag 或含空白/控制字符会被拒绝。Coder template parameter 名字如果包含 `token`、`key`、`secret`、`password` 这类承载密钥的片段会被拒绝;密钥应走 Coder template 的 secret store。如果设置 `--executor-ide-url` 或 `--executor-preview-url` 为 `http`/`https` URL 模板,Dashboard 和 Workbench 的 workspace context 会显示 `Open IDE` / `Open Preview` 链接;这些 URL 不能包含 userinfo 凭证、fragment,也不能包含 `token`、`key`、`secret`、`password`、`auth` 这类承载密钥的 query 参数。

```bash
loom harness serve \
  --workspace-root /tmp/loom-artifacts \
  --port 8787 \
  --public-url https://loom.example \
  --profile platform-readiness \
  --executor coder \
  --executor-workspace 'loom-{tenant}' \
  --executor-template loom \
  --executor-template-param auth_mode=gateway \
  --executor-template-param cpus=2 \
  --executor-template-param memory_gb=4 \
  --executor-template-param pids_limit=256 \
  --executor-remote-cwd '/home/dev/projects/{project}' \
  --executor-worktree-cwd '/home/dev/worktrees/{tenant}/{project}/{runId}' \
  --executor-ide-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/code-server' \
  --executor-preview-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/preview'
```

完整平台 readiness 路径可以把 Coder executor、Gitea/Forgejo PR、LiteLLM/OpenAI-compatible model、role-based tenant auth 和 brain ingest 放在同一个服务里,再用显式外部检查跑 smoke。`GET /status` 会报告 `readiness.ok` 和 `readiness.missing`;`loom harness smoke --profile platform-readiness` 会在长检查开始前先因为缺少必需集成而失败:

```bash
export LOOM_MODEL_KEY=...
export LOOM_GITEA_TOKEN=...
export LOOM_ALICE_GITEA_TOKEN=...
export LOOM_GITEA_WEBHOOK_SECRET=...
loom harness serve \
  --workspace-root /tmp/loom-artifacts \
  --port 8787 \
  --public-url https://loom.example \
  --profile platform-readiness \
  --executor coder \
  --executor-workspace 'loom-{tenant}' \
  --executor-template loom \
  --executor-remote-cwd '/home/dev/projects/{project}' \
  --executor-worktree-cwd '/home/dev/worktrees/{tenant}/{project}/{runId}' \
  --executor-ide-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/code-server' \
  --executor-preview-url 'https://coder.example.com/@{tenant}/loom-{tenant}/apps/preview' \
  --model-base-url https://litellm.example \
  --model-key-env LOOM_MODEL_KEY \
  --default-model gpt-5 \
  --control-plane-pr \
  --control-plane-merge \
  --control-plane-comment \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url https://git.example \
  --tenant-control-plane-token-env alice=LOOM_ALICE_GITEA_TOKEN \
  --control-plane-token-env LOOM_GITEA_TOKEN \
  --ingest-brain \
  --tenant-key-env alice=LOOM_ALICE_DEV_TOKEN:eno:developer \
  --tenant-key-env alice=LOOM_ALICE_VIEWER_TOKEN:auditor:viewer \
  --tenant-key-env alice=LOOM_ALICE_ADMIN_TOKEN:ops:admin
```

```bash
LOOM_SMOKE_TOKEN=dev-secret LOOM_SMOKE_VIEWER_TOKEN=read-secret LOOM_SMOKE_ADMIN_TOKEN=admin-secret \
loom harness smoke \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project smoke-platform \
  --template vas-lite \
  --token-env LOOM_SMOKE_TOKEN \
  --viewer-token-env LOOM_SMOKE_VIEWER_TOKEN \
  --admin-token-env LOOM_SMOKE_ADMIN_TOKEN \
  --profile platform-readiness
```

```bash
curl -s http://127.0.0.1:8787/runs \
  -H 'content-type: application/json' \
  -d '{
    "async": true,
    "queue": true,
    "tenant": "alice",
    "repo": "https://git.internal/team/proj-a.git",
    "branch": "task/alice-async",
    "baseBranch": "origin/main",
    "issue": "team/proj-a#42",
    "pullRequest": true,
    "reviewRequired": true,
    "deploymentRequired": true,
    "goal": "create async.txt",
    "script": [
      {
        "message": "write file",
        "actions": [
          {
            "toolName": "shell.exec",
            "input": { "command": "sleep 1; printf async-ok > async.txt" }
          }
        ]
      },
      { "message": "finish", "finish": true }
    ],
    "verify": ["test -f async.txt"],
    "evaluate": ["test -s async.txt"],
    "reviewer": ["printf 'reviewer: inspect generated diff'"],
    "skills": ["coding"]
  }'
```

可选的 `"evaluate"` 数组是 verification 之后的独立 evaluator gate,会写入 `evaluation` 事件和 `summary.evaluation`;任一 evaluator command 失败都会让 run 变成 `failed`,不会打开 review/deployment gate。可选的 `"reviewer"` 数组是 verification/evaluation 通过后的非 gate 机器复核 pass,会写入 `reviewer` 事件和 `summary.reviewer`,但 merge/deployment 决策仍然交给人审。可选的 `"issue"` 字段会写进 `summary.json`,也会作为 `run_metadata` 事件进入事件日志。成功发布 issue comment、创建 PR、合并 PR、写入 brain 时都会追加带 requester 的 `external_effect` 事件;配置 `--public-url` 时,issue comment、PR 创建和 brain ingest effect 还会带 dashboard、summary、review-summary、handoff-package 和 follow-up lineage 链接。Issue comment 会在可用时包含 requester、dashboard、summary、review-summary、handoff-package、follow-up lineage 链接、verification/evaluation/reviewer 命令列表、PR 链接、gate 状态,以及失败 run 的 brain failure/focus 提示;映射 developer/admin 可以在 linked run issue 上发 `/loom run-handoff-followup` 启动继承式 handoff follow-up run,其余正文作为 reviewer note;PR body 也会包含 requester、run evidence 链接、verification/evaluation/reviewer 命令列表和 gate 状态。如果已配置的 issue reporter 在发布最终评论时失败,run 会被记录成 `status: "error"` 并追加 `error` 事件和 `summary.error`。`"pullRequest": true` 会要求用带 `--control-plane-pr` 的服务通过配置好的 control-plane adapter 从 `"branch"` 到 `"baseBranch"` 创建 provider PR,并把 PR 链接写回 summary;如果没有配置 PR reporter,请求会在 run 开始前被拒绝,PR reporter 失败会被记录成 `status: "error"`、`error` 事件和 `summary.error`。`"reviewRequired": true` 会让验证和 evaluation 都通过后的状态停在 `status: "review_required"`,直到人审 PR。`"deploymentRequired": true` 会让验证和 evaluation 都通过后的状态停在 `status: "deployment_required"`,直到 admin 批准生产部署;如果 review 和 deployment 两个 gate 都开,review 通过后会进入部署审批,不会直接变成 passed。

要评论 issue 或创建 PR,必须显式开启 reporter token:

```bash
export LOOM_GITEA_TOKEN=...
export LOOM_ALICE_GITEA_TOKEN=...
export LOOM_GITEA_WEBHOOK_SECRET=...

loom harness serve \
  --workspace-root /tmp/loom-artifacts \
  --port 8787 \
  --public-url https://loom.example \
  --control-plane-pr \
  --control-plane-merge \
  --control-plane-comment \
  --control-plane-comment-sync \
  --control-plane-webhook-secret-env LOOM_GITEA_WEBHOOK_SECRET \
  --control-plane-url http://git.internal:3000 \
  --tenant-control-plane-token-env alice=LOOM_ALICE_GITEA_TOKEN \
  --control-plane-token-env LOOM_GITEA_TOKEN
```

`--tenant-control-plane-token-env tenant=ENV_NAME` 让共享 HTTP 服务用 tenant-scoped control-plane token 执行 PR、issue comment、issue comment sync、workspace PR handoff 和 merge 调用;没有 tenant 专属 env 时会回退到 `--control-plane-token-env`。旧的 `--tenant-gitea-token-env` 和 `--gitea-token-env` 仍作为默认 provider 的兼容别名可用。`loom harness doctor` 会在启动前报告缺失的 token 或 webhook secret env 名称,但不会打印对应值。对 `--control-plane-*` flag 和 `--control-plane-provider agent-git-service`,serve 启动时的缺 token 错误也会使用 provider-neutral 的 `--control-plane-token-env` / `control-plane token` 文案;旧 Gitea flag 继续保留旧文案。

审批或拒绝一个卡在 review gate 的 run:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/review?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "decision": "approved", "note": "Looks good.", "merge": true }'

curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/review?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "decision": "rejected", "note": "Needs changes." }'
```

`merge: true` 只允许用于 approved decision,且只有服务启动时带 `--control-plane-merge` 才会真正合并 PR;否则 approval 只更新 run summary,不做外部 merge。`--gitea-merge` 仍作为默认 provider 的兼容别名可用。Merge reporter 失败时 run 会保持 pending review,并追加 `error` 事件,方便重试。
Dashboard 选中 pending human review 的 run 或 Workbench 打开该 run 时,都会显示同一组 approve/reject 控件。
签名 Gitea/Forgejo issue comment 里单独一行 `/loom approve` 或 `/loom request-changes` 时,如果评论者映射到 developer/admin tenant key,也会对该 issue 最新的 pending review-gated linked run 提交同一套 review decision,其余正文作为 note。评论里也可以带一个 fenced `loom-contract-patch` JSON block,包含 `objective`、`constraints` 和 `successCriteria`;服务端会把它从 note 中移除并作为 `contractPatch` evidence 存起来。`/loom claim-review` 和 `/loom release-review-claim` 会走同一套映射权限,对 pending run review 做软 claim/释放。`/loom approve-deploy` 和 `/loom reject-deploy` 可以由映射到 admin 的评论者审批或拒绝 pending deployment gate。

审批或拒绝一个卡在 deployment gate 的 run:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/deployment?project=proj-a' \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{ "decision": "approved", "note": "Approved for production." }'

curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/deployment?project=proj-a' \
  -H 'authorization: Bearer admin-secret' \
  -H 'content-type: application/json' \
  -d '{ "decision": "rejected", "note": "Hold deployment." }'
```

配置 auth 时,部署决策要求 `admin` key。它会追加 `deployment_gate` run event,更新 `summary.json`,并写入 tenant 级 `deployment_decided` audit event。Dashboard 选中 pending deployment approval 的 run 或 Workbench 打开该 run 时,都会显示同一组 approve/reject 控件。

然后轮询或流式读事件:

```bash
curl -s http://127.0.0.1:8787/tenants/alice/runs/<runId>
curl -s http://127.0.0.1:8787/tenants/alice/runs
curl -s 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/events?after=2'
curl -N 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/events/stream?after=0'
curl -s 'http://127.0.0.1:8787/tenants/alice/audit?after=0'
curl -N 'http://127.0.0.1:8787/tenants/alice/audit/stream?after=0'
curl -s 'http://127.0.0.1:8787/tenants/alice/brain/signals?project=proj-a&after=0'
```

取消一个还在运行或排队中的 async run:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/cancel?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "reason": "user stopped the run" }'
```

如果另一个 server 实例持有这个 run 的 live admission claim,这里会先返回带 `cancelRequested: true` 的 `202`;继续轮询 run URL 或 event stream,直到 owning loop 写入最终 `cancel` 和 `finish` 事件。

Run comment 里的 pause request 也遵守同一个 owner-loop 规则:只要共享 workspace 里有 live run admission claim,任意 server 实例都可以接收并持久化评论和 pause request,最终 `pause` 与 `finish: paused` 事件仍由 owning loop 在下一次 agent step 前写入。

签名 issue comment 里的 `/loom pause` 也走同一条跨实例 owner-loop 路径:webhook 打到任意共享 server 实例都可以让另一个实例持有的 linked run 在下一次 agent step 前暂停,不会由非 owner 实例抢写最终状态。

如果服务重启后只剩持久化的 `running` 状态、本进程已经没有 controller,可以显式 abandon:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/abandon?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "reason": "server restarted before completion" }'
```

如果只想清理已经过期的 run lease,用 stale-only endpoint。active 或缺失 lease 会返回 `409`:

```bash
curl -s -X POST 'http://127.0.0.1:8787/tenants/alice/runs/<runId>/abandon-stale?project=proj-a' \
  -H 'content-type: application/json' \
  -d '{ "reason": "stale lease cleanup" }'
```

如果希望服务启动维护阶段自动做同样的 stale-only 清理,需要显式开启:

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --auto-abandon-stale-runs
```

旧的原生适配器仍然可用:

```bash
export LOOM_GATEWAY_KEY=...
loom project add http://git.internal/team/proj-a.git
loom hooks-install
loom goal "all tests in test/auth pass and lint is clean" -p proj-a -w task-123 -t reasoning --issue team/proj-a#123 --skill coding
loom brain score
loom brain propose
loom brain propose --gitea-pr --gitea-repo team/_skills --gitea-base main --gitea-token-env LOOM_GITEA_TOKEN
```

`loom workspace create` 现在复用和 `loomd` 相同的 Docker 硬化 profile:持久 `loom-home-<name>` 卷、配置里的 CPU/memory/pids/network/runtime 限制、只读 rootfs、有界 `/tmp`、drop capabilities 和 `no-new-privileges`。`gateway` auth 模式会注入 LiteLLM endpoint 以及 `gatewayKeyEnv` 指向的个人虚拟 key;`subscription` 模式不注入任何模型凭证。

`loom goal` 要求 `<workspaceRoot>/<project>` 已存在。启动原生 CLI 前,它会创建或复用 `<workspaceRoot>/<project>/.wt/<worktree>`;git 项目会使用隔离的 `loom/<worktree>` 分支,非 git 项目则使用持久 scratch 目录。每次启动都会写 `<worktree>/.loom/native-goal.json`,并通过 `LOOM_NATIVE_GOAL_CONTEXT` 暴露路径,记录非 secret 的 run id、condition/model 元数据、重复传入的 `--skill`、可选 `--issue` / `issueUrl`、`cold_start` 或 `resume_by_cwd`、attempt count 和退出状态,让原生 session 即便 provider resume 只是 best-effort,也有磁盘产物可审。原生 CLI 会收到 `LOOM_RUN_ID` 和 `LOOM_RUN_DIR`;重复传入的 `--skill` 也会通过 `LOOM_NATIVE_GOAL_SKILLS` / `LOOM_SKILLS` 传给进程,所以即使没有 `.claude/active-skills`,内置 Stop hook 也能把 active skills 写进 brain signal。传入 `--issue owner/repo#number` 时,原生 CLI 还会收到 `LOOM_NATIVE_GOAL_ISSUE` / `LOOM_NATIVE_GOAL_ISSUE_URL`,hook 也能通过 `LOOM_ISSUE` / `LOOM_ISSUE_URL` 读到同一个链接。Project 名必须是单个安全路径段,清洗后的 worktree id 也必须能组成安全 git ref。

`--ingest-brain` 同时会启用 `POST /tenants/:tenant/brain/signals`;tenant workspace 可以用 `developer` key 把原生 / Stop-hook 的 `RunSignal` JSON 上报到中心 brain。内置 Stop hook 会优先使用 `LOOM_BRAIN_INGEST_URL`、可选的 `LOOM_BRAIN_INGEST_TOKEN` 和 `LOOM_BRAIN_CLIENT_ID`;也会把可选的 `LOOM_RUN_ID`、`LOOM_RUN_DIR`、`LOOM_STATUS`、`LOOM_ISSUE`、`LOOM_ISSUE_URL`、`LOOM_DASHBOARD_URL`、`LOOM_SUMMARY_URL`、`LOOM_REVIEW_SUMMARY_URL`、`LOOM_HANDOFF_PACKAGE_URL`、`LOOM_HANDOFF_FOLLOWUPS_URL`、`LOOM_FAILURE_KIND`、`LOOM_MODEL_REQUEST_COUNT`、`LOOM_MODEL_PROMPT_TOKENS`、`LOOM_MODEL_COMPLETION_TOKENS`、`LOOM_MODEL_TOTAL_TOKENS`、`LOOM_MODEL_COST_USD` 和 `LOOM_BRAIN_NOTES` 写入信号。存在 `.loom/native-goal.json` 时,hook 会把它作为 `project`、`runId`、`runDir`、`issue`、`issueUrl` 的非 secret 默认值,但显式 env 优先。没有 `LOOM_BRAIN_INGEST_URL` 时继续走本地 `loom brain ingest` fallback。

完成的 HTTP run 通过这个模式写入 brain 时,会同时记录 `brain_ingest` run external effect 和 `brain_signal_ingested` tenant audit event;如果 run 执行过 reviewer pass,两条记录都会包含 `reviewerStatus`、`reviewerExitCode` 和 `reviewerCommands`。原生 `RunSignal` 上报也会写同一个 tenant audit event。`GET /tenants/:tenant/brain/signals?project=<project>&after=<seq>&limit=<n>&runId=<runId>` 会从 tenant audit 生成 viewer 可读的只读 feed,区分 `completed_run` 和 `workspace_signal` 来源,但不暴露原始 notes。

HTTP harness 写入 brain 的信号会尽量包含结构化的 `runId`、`status`、`runDir`、`issue`、`issueUrl`、`dashboardUrl`、`summaryUrl`、`reviewSummaryUrl`、`handoffPackageUrl`、`handoffFollowupsUrl`、`failureKind` 和非 secret 的模型用量聚合字段(`modelRequestCount`、`modelPromptTokens`、`modelCompletionTokens`、`modelTotalTokens`、`modelCostUsd`)。CLI/HTTP harness 会把失败 summary 归类成 `evaluation`、`verification`、`reporter`、`agent`、`tool`、`workspace-prepare`、`failed`、`error` 或 `cancelled`;原生信号可以直接传 `failureKind`,旧信号没有该字段时 `brain score` 会从 notes 推断。失败 notes 会在 verification/evaluation gate 失败时包含 exit code 和命令,也会包含 reporter/agent error 的 `summary.error.message` 以及有界 `summary.error.kind/details`;如果存在 reviewer pass/flag 或 handoff 证据,还会带 reviewer 结果、review/deployment 状态、PR URL、branch、base 和 issue link。弱技能提议会把失败归因计数、由归因派生的审查焦点清单和最近失败样本写进 PR 正文,带 run、issue、dashboard、summary、显式的 `reviewSummary`/`handoffPackage`/`followupRuns` reviewer 链接以及可用的模型用量计数/cost;没有显式字段时从 `summaryUrl` 派生,并保留 notes,方便审阅者直接回溯具体失败。重复运行 `brain propose` 或 `loomd serve` 会跳过同一信号时间戳已经开过的本地或 tracked-remote proposal 分支。Skill 标识进入分支名或 note 路径前会先 slug 化,原始标识保留在 proposal 元数据和正文里。Proposal commit 只会包含 `.brain/signals.jsonl`、`.brain/skill_evals.json` 和对应技能的 `IMPROVE.md`,不会把 skills repo 里无关的人工改动卷进自动分支。

这些失败归因或模型用量字段存在时,Dashboard 和 Workbench 的 audit 摘要也会显示同一份非 secret 的 outcome、skill 数量、request/token 计数和 cost。

Review summary 和 handoff-package JSON 也会把从有界 workspace diff 派生的结构化 `changedFiles` 提示、以及失败 run 的同一份精简 brain 证据暴露为 `brain.outcome`、`brain.failureKind` 和 `brain.reviewerFocus`;它们的 `modelUsage` 字段保留聚合后的请求/token 计数,`projectContract` / `projectContractStatus` 会把该 run 的项目目标和漂移状态作为显式 review-summary 字段保留下来,review contract patch 会继续进入 replay detail、handoff gate trail 和 issue-comment message evidence,handoff follow-up run 会把源 run 的 contract/status 作为 source evidence 继续携带,`error` 字段保留 public error message、phase、iteration、kind 和有界的非 secret 标量 details。对 `vas-lite-review` run,review summary 还会带 `vas.preset`、`vas.caseId` 和 case artifacts/runs/reviewPackage/reviewRuns 链接;handoff package 会在 `reviewSummary.vas` 里携带同一份 case 指针。Dashboard 和 Workbench 的 review summary 和 handoff lineage panel 会直接渲染这些证据,让在线 reviewer 在弱技能 proposal 出现前就能先判断失败方向。

## Harness 工具

MVP 的工具面刻意很小:

- `file.read`
- `file.write`
- `shell.exec`
- `git.diff`
- `git.commit`
- `verify.run`

所有工具执行都经过 `WorkspaceExecutor`。当前已有本地 executor、Docker executor 和 Coder SSH executor;这个接口就是以后接完整 Coder 生命周期或其他远程沙箱执行器的边界。本地 executor 只会把文件 API 限制在 workspace 路径内,不是命令和验证的 OS 级沙箱;因此带鉴权、非 loopback 或开启 shell 的 HTTP 服务必须使用 Docker/Coder,除非显式传 `--allow-unsafe-local-executor` 作为单机开发逃生口。Executor 也会暴露非 secret 的 `describeWorkspace()` 视图,并通过 `GET /tenants/:tenant/projects/:project/workspace` 和 `GET /tenants/:tenant/runs/:runId/workspace?project=<project>` 返回,让客户端在打开文件或 terminal 前能看见当前指向的是项目 workspace、Docker mount、Coder remote cwd、per-run worktree 上下文、继承到的项目 repo/branch/baseBranch 默认值、浏览器 IDE URL 或浏览器 preview URL。

要把命令和验证放进 Docker,先构建 workspace 镜像,再选择 Docker executor:

```bash
docker build -t loom-workspace:dev -f docker/workspace.Dockerfile .

loom harness run "create hello.txt" \
  --cwd /tmp/loom-demo \
  --script /tmp/loom-script.json \
  --executor docker \
  --executor-image loom-workspace:dev \
  --executor-network none \
  --verify "test -f hello.txt"
```

Docker 的文件 inspect/read/write/move/delete 通过 `WorkspaceExecutor` 使用挂载后的 workspace 路径;`shell.exec`、`git.diff`、`git.commit`、`verify.run` 会通过 hardened `docker run` 执行:默认 `--cap-drop ALL`、`no-new-privileges`、映射宿主进程 uid/gid 的非 root `--user`、强制 read-only rootfs、有界 `/tmp` tmpfs、CPU/memory/pids 限制和 `--network none`。传 `--executor-home-root /var/lib/loom-homes` 时,服务会创建 `<home-root>/<tenant>` 并挂到容器 `/home/dev`,同时设置 `HOME=/home/dev`,让每个 HTTP tenant 在 command、session 和 run 之间保留自己的 Docker home,而项目 workspace 仍单独挂在 `/workspace`。如果服务进程本身是 root 或平台没有 uid/gid API,默认降到 `1000:1000`;显式 root user 会被拒绝。自定义 executor tmpfs 也必须保持为带 `noexec` 和 `nosuid` 的有界 `/tmp` mount。

要在 Coder workspace 里跑同一套工具契约,用 Coder executor。内置 `coder-template/` 可以设置 `brain_ingest_url_template`,例如 `http://harness.internal:8787/tenants/{tenant}/brain/signals`,再用 secret 注入 `brain_ingest_token`;模板会把 `{tenant}` 替换成 Coder workspace owner,让每个 workspace 的 Stop hook 上报到中心 brain。设置 `--executor-template` 后,缺失的 workspace 会从该 template 创建并使用 Coder 参数默认值;可重复传 `--executor-template-param name=value` 为新 workspace 设置 Coder rich parameter。Coder workspace/template 标识符如果像 CLI flag 或含空白/控制字符会被拒绝。Tenant policy 的 `executorTemplateParameters` 会为每个租户追加非 secret Coder 参数。CLI 或 tenant policy 的 CPU、memory、pids 限制会覆盖同名模板参数,分别落到 `cpus`、`memory_gb`、`pids_limit`;Coder network 仍保持为模板部署级变量。设置 `--executor-ide-url` 或 `--executor-preview-url` 后,渲染出的 `http`/`https` URL 会进入 workspace context,并在 UI 里显示成 `Open IDE` 或 `Open Preview` 链接;它不能包含 userinfo 凭证、fragment 或承载密钥的 query 参数。设置 `--repo` 或 HTTP `"repo"` 后,prepare 会在缺失时 clone 到 `--executor-remote-cwd`,已存在时运行 `git fetch --all --prune`;设置 `--branch` 或 HTTP `"branch"` 后,prepare 会切到该分支,不存在则从 `--base-branch` / `"baseBranch"` 创建,默认 `origin/main`。Run 事件产物仍写在本地 `--cwd` / `--run-root`,文件工具、命令工具和 HTTP workspace 文件 API 都在远端执行。

要做每次 run 独立隔离,加 `--executor-worktree-cwd`。这时 `--executor-remote-cwd` 表示远端 canonical repo 目录,工具实际在渲染后的 worktree 目录执行,HTTP server 的 active-run admission 也会从 project workspace 锁切到 run workspace 锁。这样多个 async agent 可以在同一个 tenant/project 下并行跑各自 worktree;最终汇合点仍是 PR、review 和 handoff 证据,不是共享可变文件。该模式会在 server/tenant status 的 `server.runWorkspaceIsolation` 暴露,`platform-readiness` 要求值为 `run`。Executor 模板支持 `{tenant}`、`{project}`、`{cwdBase}`、`{runId}`。

```bash
loom harness run "fix tests remotely" \
  --cwd /tmp/loom-artifacts \
  --script /tmp/loom-script.json \
  --executor coder \
  --executor-workspace alice-dev \
  --executor-template loom \
  --repo https://git.internal/team/proj-a.git \
  --branch task/proj-a-123 \
  --issue team/proj-a#123 \
  --require-review \
  --require-deployment \
  --public-url https://loom.example \
  --base-branch origin/main \
  --executor-remote-cwd /home/dev/projects/proj-a \
  --executor-worktree-cwd '/home/dev/worktrees/local/proj-a/{runId}' \
  --executor-ide-url 'https://coder.example.com/@local/alice-dev/apps/code-server' \
  --verify "npm test"
```

当 CLI run 可以通过 harness server 访问时,传 `--public-url` 后,`--gitea-pr` / `--gitea-comment` 会带上 dashboard、summary、review-summary、handoff-package 和 follow-up lineage 链接。`--require-review` 会在验证通过后停在人审 merge gate,`--require-deployment` 会停在 `deployment_required` 等待生产部署审批。加 `--gitea-pr --gitea-token-env LOOM_GITEA_TOKEN` 后,CLI run 会从 `--branch` 创建一个带验证/gate 上下文的可审 PR;加 `--gitea-comment` 后会把最终 summary、verification 命令、PR 链接、gate 状态和失败 run 的 brain failure/focus 提示评论到关联 issue;当 run summary 里有 requester 时也会一并带上。没有这些 flag 时,`--issue` 只记录元数据,不产生外部副作用。CLI reporter 成功会追加 `external_effect` 事件;失败会非零退出,并向 run 追加 `error` 事件。

后面接真实模型 agent 时用 `--agent-command`:命令从 stdin 收当前 loop 状态 JSON,从 stdout 输出一个 AgentStep JSON。AgentStep 支持 `message`、可选 `plan`、`actions` 和 `finish`;`plan` 会进入 `assistant_message` 事件和 replay detail,用于审计/复盘,不影响工具执行。Adapter 输出会在任何工具执行前做 schema 校验:每个 action 都需要非空 `toolName` 和对象型 `input`,坏 step 会作为 agent error 失败,不会漏到 tool runtime 里变成含糊错误。OpenAI-compatible model adapter 默认使用 JSON AgentStep response,也可以用 `--model-protocol tool-call` 或 HTTP `"modelProtocol": "tool-call"` 请求单个 `agent_step` tool call。它的 prompt 和 tool-call schema 会按最新 `run_policy.allowedTools` 收窄,让 model-backed run 看到的工具面和 runtime 实际执行的工具面一致。它会把 HTTP、空内容/tool-call、JSON 和 AgentStep schema 失败包装成不含 secret 的 `kind/details`,方便 replay 和 handoff triage;它会对一次模型协议失败做 bounded repair retry,并先写入可审计的 `agent_retry` 事件。

也可以直接用 `--model` 接 LiteLLM/OpenAI-compatible chat-completions:

```bash
loom harness run "fix failing tests" \
  --cwd /path/to/project \
  --model kimi-k2.6 \
  --model-base-url http://localhost:4000 \
  --model-key-env LOOM_GATEWAY_KEY \
  --model-protocol tool-call \
  --verify "npm test" \
  --skill coding
```

`loom harness serve` 把同一个 loop 暴露成 HTTP。Run 会存到 `<workspace-root>/<tenant>/<project>/.loom/runs`;`project` 默认是 `default`。同步 run 返回 `201` 和最终 summary;异步 run 返回 `202` 和 `status: "running"`,之后通过同一组 summary/events URL 收敛。默认情况下,同一个 tenant/project 同时只允许一个 active run;冲突创建默认返回 `409`,但 async 创建带 `"queue": true` 时会排队;不同 project 可以并行。配置 Coder `--executor-worktree-cwd` 后,active-run admission 会按 run 锁定 workspace,所以同一个 tenant/project 也可以让多个 async run 在独立 worktree 中并行;`--max-tenant-active-runs` 仍会限制单 tenant 总并发。当单 tenant run cap 已满、目标 project workspace 正忙,或 project-lock 模式下持久化 running run 仍占用该 project 时,带 `"queue": true` 的异步创建会返回 `202` 和 `status: "queued"`,包含 `tenantQueuePosition`、`projectQueuePosition` 和当前 `blockedReason`,并在 tenant/project slot 释放后自动启动;queued run 会持久化,server 重启后会恢复调度,也能通过同一个 run URL 读取。运行中的 async status 会写入 `heartbeatAt` 和 `leaseExpiresAt`,并在 run 结束前持续刷新;`--run-lease-ttl-ms` 控制 TTL。Project-lock 模式下,服务重启后持久化的 `running` 状态在 lease 仍有效或缺失时会继续占用 project;过期 lease 会被报告为 stale,并且不再阻塞新 run。用 `POST /tenants/:tenant/runs/:runId/abandon` 可以把失去 controller 的 orphaned running run 标成 `cancelled`;用 `POST /tenants/:tenant/runs/:runId/abandon-stale` 可以只清理 lease-expired orphan;两者都会拒绝仍有另一个 server 实例 live active-run admission claim 的 run。`--auto-abandon-stale-runs` 会在服务启动时启用同样的 stale-only 自动清理,并跳过带 live claim 的远端 running run。运行中或排队中的 async run 可以用 `POST /tenants/:tenant/runs/:runId/cancel` 取消;它会追加 `cancel` 和 `finish` 事件,并记录 `status: "cancelled"`。Dashboard 和 focused workbench 都会在 run summary 里直接展示 `summary.error`。`GET /workbench?tenant=<tenant>&project=<project>&runId=<runId>` 会提供某个 run 的 focused browser workbench,包含 workspace/executor 上下文,以及由 tenant audit SSE stream 驱动的 run-filtered audit panel、已加载 follow-up child 的 lineage 状态刷新,以及 audit 触发的当前 run 静默 summary、replay、review summary、handoff package、file、command、session 刷新;child workspace activity 不会被当成 source run activity,也不会清空当前 command error 或在临时失败时替换已加载的 replay、review summary/handoff package 面板或 follow-up lineage。对 running/queued run,Workbench 还会加载当前 run events,以按 seq 去重且保留浏览器原生重连的 `harness_event` SSE 订阅刷新 replay,并在 finish 后关闭该 run stream。`GET /tenants/:tenant/projects/:project/presence` 会列出该 project 的 active dashboard collaborators,`GET /tenants/:tenant/runs/:runId/presence` 会列出该 run 的 active workbench collaborators;`POST .../presence` 会把 `{ clientId, label, focus }` heartbeat 写入 45 秒的内存加文件 presence registry:project presence 在 `.loom/presence/project`,run presence 在 `.loom/runs/<runId>/presence`,所以共享 workspace root 的多个 server 实例能看到同一批协作者和同文件 active editor 提示。其中 `focus` 来自当前 file/run/command/session 焦点,Workbench 复核 VAS case 时也会显示 `vas:<caseId>`。Dashboard 和 Workbench 在 presence name 或 focus 变化时会立即 heartbeat。`GET /tenants/:tenant/runs/:runId/replay` 会从已存事件日志派生紧凑的人类可读 timeline,包含 actor/role/clientId 上下文、external-effect requester、assistant plan、verification、evaluator 结果和 reviewer command evidence。`POST /tenants/:tenant/runs/:runId/comments?project=<project>` 会追加 viewer 可写的 `user_message` run comment,带 actor/role/clientId 上下文,刷新 replay/handoff 视图,并写入 `run_comment_added` tenant audit。请求体带 `"pause": true` 时,服务端要求该 run 是当前进程 active run,写入 pause request,loop 会在下一次 agent step 前追加 `pause` 和 `finish: paused` 事件,并把 summary 写成 `status: "paused"`。`POST /tenants/:tenant/runs/:runId/resume?project=<project>` 要求 `developer` 权限,从持久化 request snapshot 重建原异步 run,追加 `resume` 事件,跳过已记录的 scripted step,并沿用同一个 runId/event log 继续跑到新的 finish 状态。通过 issue comment sync 或签名 webhook 进入 run log 的 `/loom approve` 和 `/loom request-changes` 会要求评论者映射到 developer/admin;run-scoped sync 决策当前 run,webhook 只决策该 issue 最新的 pending review-gated linked run,其余正文作为 note。`GET /tenants/:tenant/runs/:runId/review-summary?project=<project>` 会返回 run metadata、requester 身份、review/deployment gate 状态、verification/evaluation/reviewer 摘要、replay timeline、结构化 `changedFiles` 提示和排除 `.loom` 的有界 workspace git diff;它要求 allowlist 里有 `git.diff`,不要求开启 `shell.exec`。对 `vas-lite-review` run,它还会返回 `vas.preset`、`vas.caseId` 和 case artifacts/runs/reviewPackage/reviewRuns 链接。`GET /tenants/:tenant/runs/:runId/handoff-package?project=<project>` 会返回同一份 review summary,再加 workspace 上下文、run-scoped command/session 摘要、最新 commit/PR handoff 证据、dashboard/API/workbench 链接和按该 run 过滤的 tenant audit trail,方便 reviewer 直接接手;它同样要求 `git.diff`。`POST /tenants/:tenant/runs/:runId/handoff-runs?project=<project>` 要求 `developer` 权限,会从该 handoff 上下文创建 async queued follow-up run,默认继承 repo/branch/baseBranch/issue 和原 run 的 `preset`/`presetInput`,在新 run 开头写入结构化 `handoff_followup` `user_message`,在新 run metadata 写入 `handoffSource*` 字段,并用 `run_handoff_followup_created` audit 记录 source run 到 `followupRunId` 的谱系。同样的 follow-up 也可以通过 linked run issue comment 里的 standalone `/loom run-handoff-followup` 启动;评论者必须映射到 developer/admin,服务会按 comment 去重,默认接续最新匹配的 source run,会把触发评论 id/url 写进 child run metadata 和 seed,其余正文作为 reviewer note。`POST /tenants/:tenant/runs/:runId/review-claim?project=<project>` 允许 developer/admin 用 `{ "action": "claim" | "release", "clientId": "..." }` 对 pending human review 做软 claim 或释放,会更新 `summary.review.claim`,追加 `review_claim` run event,并写入 `run_review_claimed` tenant audit,但不阻塞其他 reviewer。Review decision 会追加 `review_gate` 事件并重写 `summary.json`;可选的 `contractPatch` 会随 `review_gate` 和 `review_decided` audit 持久化,approved 决策会把它写回 project contract 并记录 `project_contract_updated`,rejected 决策只保留为修复建议证据。deployment decision 会追加 `deployment_gate` 事件,且配置 auth 时要求 `admin` 权限。

GitHub-compatible provider 可以用 `POST /tenants/:tenant/webhooks/control-plane/issue-comments?project=<project>&provider=agent-git-service` 和同一个 webhook secret 加 `X-Hub-Signature-256`;省略 `provider` 时,该路由会默认使用服务端的 `--control-plane-provider`,所以 `--control-plane-provider agent-git-service` 不需要 query override 也能接收同一个 endpoint。同步后的 event/audit 会保留 `controlPlaneProvider`、comment id/url、delivery id 和 provider 前缀外部 actor。要让这些签名评论驱动 review/claim/VAS/handoff 命令,在 tenant policy 里加 `controlPlaneIdentities`,例如 `{ "provider": "agent-git-service", "externalActor": "octo-agent", "actor": "alice-agent", "role": "developer" }`。`loom harness serve --control-plane-provider agent-git-service` 会把 issue comments、PR creation、merge、issue URL、status、doctor、启动 token 校验和 smoke 证据切到 GitHub-compatible adapter,但默认 provider 仍是 Gitea/Forgejo。如果没有显式传 `--control-plane-url` 或 `--control-plane-token-env`,这个 provider 会读取 `LOOM_AGENT_GIT_SERVICE_URL` 和 `LOOM_AGENT_GIT_SERVICE_TOKEN`;doctor 只报告 env 名、`tokenMode`、tenant token env names、provider 派生的 `controlPlaneGitTransport.sampleRemoteUrl`、provider catalog 的 `/api/v3` discovery/native capability evidence 和 workspace branch lease evidence,不会输出 token 值。Smoke 推荐使用 provider-neutral 的 `--check-control-plane-pr` 和 `--check-control-plane-comments`,旧 `--check-gitea-pr` / `--check-gitea-comments` 保留为兼容别名;输出会同时带 `controlPlanePr*` / `controlPlaneComments*`、`serverControlPlaneApiBasePath` / `serverControlPlaneDiscoveryEndpoints` / `serverControlPlaneNativeCapabilities`、workspace branch lease 字段和旧 `gitea*` 兼容字段,方便 CI 检查 adapter seam 而不是检查 Gitea 命名。AGS adapter 也已经暴露 `createAgentGitServiceAgent(...)` 对应 `POST /api/v3/agents`,`grantAgentGitServiceRepoAccess(...)` 对应 `PUT /api/v3/repos/{owner}/{repo}/collaborators/{agent}`,`/api/v3/repos/{owner}/{repo}/issues/{number}/workspaces` 下的 issue workspace presence/attachment helpers,以及 `/api/v3/repos/{owner}/{repo}/wiki/memory/{page}` 下的 wiki memory helpers。新增 `src/harness/agent-git-service-provisioning.ts` 的 `provisionAgentGitServiceProjectAgent(...)` 会为已存在 tenant/project 组合注册和授权 helper,并只把非 secret receipt 写到 `.loom/control-plane/agent-git-service/provisioning.json`,包含 `tokenEnvName` 和 `tokenMaterial: "returned-only"`;生成的 agent token 只返回给调用方,不会写入 `.loom`。下面的 admin HTTP provisioning endpoint 会复用这个 helper,也可以在同一次请求里显式写入非 secret 的 tenant `controlPlaneIdentity` 映射;如果服务端用 `--agent-git-service-token-secret-root` 启动,同一路径还可以把生成的 agent token 写入服务端 secret root。共享 control-plane provider interface 也暴露 `gitRemoteUrl(baseUrl, repo)`,所以 Gitea/Forgejo 和 `agent-git-service` 都能派生 provider-neutral `.git` remote,供 clone/push wiring 使用。

Provisioning receipt update, 2026-06-30:`POST /tenants/:tenant/projects/:project/control-plane/agent-git-service/provision` 是 `--control-plane-provider agent-git-service` 下的 admin-only endpoint。它会为已存在 tenant/project 注册 AGS agent、授权 repo、只写入不含 token 的 `.loom/control-plane/agent-git-service/provisioning.json`,并记录不含 token 的 audit/project activity。默认情况下,生成的 AGS agent token 只在响应里以 `agentToken` 返回一次;如果请求带 `"storeAgentToken": true`,服务端必须配置 `--agent-git-service-token-secret-root <path>`,会把 token 以 `0600` 文件写到 `<path>/<tenant>/<project>/<tokenEnvName>`,响应和 audit 只返回不含 token 的 `agentTokenSecret`,例如 `{ "stored": true, "tokenEnvName": "...", "secretRef": "alice/proj-a/LOOM_AGENT_TOKEN" }`。当 receipt 和 secret 文件都存在时,project/run workspace prepare,包括 Coder git clone/fetch/worktree setup、run/workspace command 和 workspace session,都会通过 executor environment 取得 `tokenEnvName` 对应的 token;Coder git prepare 还会收到不含 secret 的 `gitCredential.tokenEnvName` 提示,并为 clone/fetch/worktree/switch 安装临时 `GIT_ASKPASS` 脚本,所以 token 不会写入 `.git/config`、run summary、command summary、tenant audit、status、receipt 或 project metadata。请求可带 `controlPlaneIdentity`,例如 `{ "actor": "alice-agent", "role": "developer" }`;此时服务端会把新建的 AGS `agentLogin` 作为 external actor 写入 tenant policy,并记录非 secret policy audit。没有显式传这个 block 就不会授予任何租户角色。`GET` 同一路径只返回 receipt;重复 `POST` 默认 `409`,除非操作者显式传 `"force": true`。它仍不是自动 tenant cutover。

Provisioning plan 更新,2026-07-01: `GET /tenants/:tenant/control-plane/agent-git-service/provisioning-plan` 是 `--control-plane-provider agent-git-service` 下的 admin-only、只读 operator plan。它会列出该 tenant 的每个已注册 project,包含不含 token 的 receipt/secret readiness、repo/source-default 覆盖、生成的默认 `tokenEnvName`、ready/provisioned/secret-stored/missing 计数,以及需要首次 provisioning 或 secret 缺失后强制重建的 `provisionCommandArgs`。它只检查服务端 secret 文件是否存在,不会把 token material 放进响应,也不会调用 AGS、写 audit 或自动 rollout。后续批量 AGS onboarding 应该接在这个 plan 上。Dashboard Server 面板和 CLI 都能读取同一份 plan:`loom harness agent-git-service-provisioning-plan --url http://127.0.0.1:8787 --tenant alice --admin-token-env LOOM_ADMIN_TOKEN`;输出是服务端 JSON,不会回显 admin token。`POST /tenants/:tenant/control-plane/agent-git-service/provisioning-plan/apply` 是对应的 admin-only batch apply:只处理 plan 判定 eligible 的项目,把生成的 project-agent token 存进 `--agent-git-service-token-secret-root`,按项目返回 `provisioned` / `skipped` / `failed` 状态,不返回 token material,并写入不含 token 的 audit。先用 Dashboard Server 面板的 Dry Run Apply,或 `loom harness apply-agent-git-service-provisioning-plan --url http://127.0.0.1:8787 --tenant alice --admin-token-env LOOM_ADMIN_TOKEN --dry-run`;然后用 Dashboard Apply Plan 或去掉 `--dry-run` provision 所有 eligible 项目,也可以用 `--projects proj-a,proj-b` / Dashboard projects 输入框限定批次,或用 `--eligible-only` / Dashboard 的 Eligible projects only 复选框让 apply 结果省略 ready/skipped 行。缺 AGS project-agent 的 Dashboard project card 也能把该项目直接填进同一个 plan 表单并启用 eligible-only。

AGS native handoff 更新,2026-07-01: 当 server 以 `--control-plane-provider agent-git-service` 运行,并配置了 `--control-plane-url`、`--control-plane-token-env` 和 public URL 时,成功的 run-scoped workspace PR handoff 会读取 linked issue 的 AGS issue workspaces,选择 branch 匹配的 workspace,然后把该 run 的 handoff package URL 发布成 AGS workspace attachment。Run log 会记录不含 token 的 `external_effect`,其中 `kind: "agent_git_service_workspace_attachment"`,并带 workspace/attachment id。这只是 online sandbox handoff 的附加证据;不会替代我们自己的 handoff package、tenant audit、review gate 或 PR handoff。

AGS wiki memory 更新,2026-07-01: approved `vas-lite` learning 仍然先写回项目本地的 `vocabulary/learned-patterns.md` 和 tenant audit。当 server 以 `agent-git-service` 配置了 control-plane URL/token,且 VAS case 有 repo ref 时,同一批经过 review approve 的 learning 也会追加到 AGS repo wiki memory page `vas/learnings`。成功或失败都会写入不含 token 的 tenant audit(`agent_git_service_wiki_memory_updated` / `agent_git_service_wiki_memory_failed`),所以 AGS memory 只是已审核 harness evidence 的投影,不是事实源。

AGS native projection smoke 更新,2026-07-01:`loom harness smoke --profile platform-readiness --control-plane-provider agent-git-service` 现在会把这些原生投影转成 CI 可断言字段。当 handoff attachment 和 wiki memory 两边都成功时,输出会包含 `agentGitServiceNativeProjectionChecked`、`agentGitServiceHandoffWorkspaceAttachment*`、`agentGitServiceWikiMemory*`,并在 `onlineSandboxGoldenPathCapabilities` 里追加 `agent-git-service-native-projection`。AGS adapter 也接受 `https://git.example/team/app.git` 这类常见 Git remote URL,在 wiki-memory 投影时会规范化成 `owner/repo`。

Cutover gate 更新,2026-06-30: 在 `--profile platform-readiness --control-plane-provider agent-git-service` 下,`GET /status` 和 `loom harness doctor` 会扫描已注册的 tenant/project 目录,并暴露 `readiness.checks.agentGitServiceProjectAgents` / `checks.agentGitServiceProjectAgents`。任何 project 缺少 AGS provisioning receipt,或缺少 `--agent-git-service-token-secret-root` 下对应的 token 文件,都会让 readiness 失败,输出里只包含 `missingProjects` / `missingSecretProjects` 的 project ref,不包含 token。`loom harness smoke --profile platform-readiness` 在该 check 存在时,也会把同一组非 secret 的 `agentGitServiceProjectAgents*` 诊断写进失败 details 和成功 JSON 输出。Dashboard Server 面板会渲染同一个非 secret check,显示已 provisioning / 已存 secret 的项目计数,以及缺 receipt / 缺 secret 的 project ref。Project list/detail 也会暴露逐 project 的 `controlPlane.agentGitServiceProjectAgent` readiness,包含 `receiptPresent`、`secretStored`、`ready`、receipt 元数据和 `tokenEnvName`,但不会暴露 token material。使用 `--control-plane-provider agent-git-service` 时,platform-readiness smoke 还会默认运行 cutover rehearsal,并在 `onlineSandboxGoldenPathCapabilities` 里记录 `agent-git-service-cutover`,演练已存 project-agent token 是否真的注入 workspace command,且不暴露 token material。只有 token-free receipt 和服务端 secret root 中的 token 文件都存在时,该 tenant/project 才算 AGS path cutover ready。

操作者也可以通过 CLI 调同一个 admin endpoint,避免把 admin token 写进 shell history:

```bash
LOOM_ADMIN_TOKEN=admin-secret loom harness provision-agent-git-service \
  --url http://127.0.0.1:8787 \
  --tenant alice \
  --project proj-a \
  --repo team/app \
  --permission admin \
  --agent-prefix-login loom-alice-proj-a \
  --default-repo-name proj-a \
  --token-env-name LOOM_ALICE_PROJ_A_AGENT_TOKEN \
  --identity-actor alice-agent \
  --identity-role developer \
  --store-agent-token \
  --admin-token-env LOOM_ADMIN_TOKEN
```

省略 `--store-agent-token` 时,这个命令会打印服务端响应,包括一次性返回的 `agentToken`;带上该选项时,服务端必须配置 `--agent-git-service-token-secret-root`,响应只包含不含 token 的 `agentTokenSecret` 证据。Dashboard 的 Server 面板也暴露同一个 admin-only provisioning 操作,针对当前选中的 tenant/project,复用当前登录的 admin key,并可请求服务端存储 token,而不是把 token 写入 `.loom` 或浏览器响应。

Queued run recovery 会把 `queued_run_recovered` 或 `queued_run_recovery_failed` 写入 tenant audit,包含 run id、queued timestamp 和 queue position 证据。

Run review claim 被其他 reviewer 接手时,会在 `review_claim` run event 和 `run_review_claimed` tenant audit 中记录 `previousClaim`,但 claim 仍是 soft signal,不会变成硬锁。
Project `latestControlActivity` 也会为 run review 和 VAS claim 事件携带同一份 `previousClaim`,所以 project card 不打开 audit feed 也能显示 takeover 或 release 证据。

`POST /runs` 也接受调用方生成的 `clientRequestId` 幂等键。服务端会把 resolved request hash 持久化到共享 run store;同一 tenant/project/requester/body 的重试或同时创建即使打到另一个 server 实例,也会返回原 run 并带 `idempotentReplay: true`;同一个 key 搭配不同 resolved request 会返回 `409`。

创建 HTTP run 时可同时传 `"syncIssueComments": true` 和 `issue`,服务会把已有的非 Loom Gitea/Forgejo issue comment 作为初始 `user_message` 事件写入新 run log,再启动 agent loop。它复用 `POST .../issue-comments/sync` 所需的 issue comment reader 配置,并写入带 `initial: true` 的 `run_issue_comments_synced` tenant audit。

Replay、review-summary、handoff-package 和 handoff-runs 响应都会带 `checkpoint`,包含 `schemaVersion`、短 `version` hash、run event 锚点,以及相关的 audit/follow-up 锚点。Dashboard 和 Workbench 会渲染 checkpoint version,并在证据面板静默刷新时用它提示已加载的 replay/review/handoff 上下文是否变化;如果临时刷新失败,界面会保留旧 checkpoint,而不是丢掉仍可用的上下文。浏览器启动 handoff follow-up 前会先确保 handoff package checkpoint 已加载,再带上它的 `sourceCheckpointVersion`;`POST .../handoff-runs` 遇到过期版本会返回 `409`,写入带 actor/client 和 observed checkpoint 证据的 `run_handoff_followup_denied` tenant audit,并返回当前 checkpoint,避免 reviewer 基于旧证据继续接力。浏览器遇到这个情况时会静默刷新已加载的 handoff package,并提示 reviewer 基于新 checkpoint 重试。

Workbench 的 replay 除了 running/queued run 的 live event stream,也会跟随匹配的 audit gate/control 事件刷新,包括 review/deployment decision、cancel、resume、abandon、stale abandon、review claim 和 PR handoff。

Handoff package 还会包含从 run gate event 派生的结构化 `gateTrail`,以及初始 linked issue context sync 的 `issueCommentSeeds`,用于显示 review/deployment gate 何时打开或变化、同步了多少外部 issue 上下文,以及对应的 client/actor 上下文。

Workbench 里的 handoff package 会优先把结构化 `changedFiles` 提示和 run-scoped command/session 摘要渲染成可点击入口,直接打开对应 workspace 文件、command 输出或 session transcript;删除文件会回退打开父目录。

Handoff package 会从 `external_effect` run event 派生 `externalEffects`,覆盖 issue comment、PR 创建、merge 和 brain ingest 等外部副作用,并带 requester/client 上下文和常用 issue/PR/evidence 链接。

Handoff package 也会从 `user_message` event 派生结构化 `messages`,让 reviewer 能直接看到原始目标、浏览器 run comment、同步进来的 issue comment、命令型评论和 `handoff_followup` seed,以及 actor/client 元数据和存在时的 issue-comment 触发证据。`links.followupRuns` 是从该交接包启动继承式 follow-up run 的 API 入口,`followupRuns[]` 会列出现有子 run 的当前状态和链接。Follow-up run 的首条 `handoff_followup` message 会带有界的源 run changed-file、command 和 session 证据,让下一个开发者或模型不用先重新打开完整交接包也能接续;子 run summary 也保留 source Workbench/package 链接,方便 reviewer 在多代交接之间回溯。

Tenant audit 也会记录来自 completed-run brain ingest 和原生 Stop hook 信号的 `brain_signal_ingested`;completed harness run 还会带 reviewer 状态,让 Dashboard/Workbench 不读 run log 也能看到 brain 反馈。

Run-scoped workspace PR handoff 可以带 `"reviewRequired": true` 和/或 `"deploymentRequired": true`;两种 gate 都打开时,review 通过后会进入 pending deployment approval。
Gitea/Forgejo issue comment webhook 会同时匹配 linked run 和 `case.issue`;如果 case 没有自己的 issue,会用 project source-default issue 作为匹配后备。授权的 `/loom claim-vas [caseId]` 和 `/loom release-vas-claim [caseId]` 评论会对唯一匹配或显式指定的 VAS case 做 soft claim/释放;多个 case 绑定同一 issue 时需要传 `caseId`。授权的 `/loom run-vas-review` 评论即使在还没有任何历史 run 时,也能从唯一匹配的 VAS case 启动第一轮 async review run。授权的 `/loom run-handoff-followup` 评论能从 linked run 的 handoff package 上下文启动继承式 async follow-up run,并把 source checkpoint 写入 child metadata、seed 和启动审计。首个 VAS review run 从 issue webhook command 启动时,这条 command comment 会写入新 run 的 event log,tenant audit 也会记录新 run id、case id、comment id 和 delivery id。
已有 linked VAS run 上的 `/loom run-vas-review` 会让子 review run 继承源 run 的 `model` 和非默认 `modelProtocol`,让 tool-call 模型 loop 在 Gitea 接力时保持同一个 adapter contract。Workbench 从当前 VAS run 启动下一轮 review run 时也会按同样方式继承当前 run metadata。
普通 run review 的 `/loom claim-review` 和 `/loom release-review-claim` 会写入同一个 run log;run-scoped sync 目标当前 run,webhook 目标该 issue 最新的 pending review-gated linked run。
Deployment gate 的 `/loom approve-deploy` 和 `/loom reject-deploy` 会写入同一个 run log;run-scoped sync 目标当前 run,webhook 目标该 issue 最新的 pending deployment-gated linked run,其余正文作为 deployment note。
Provisioning receipt 更新,2026-06-30: `POST /tenants/:tenant/projects/:project/control-plane/agent-git-service/provision` 现在是 `--control-plane-provider agent-git-service` 下的 admin-only endpoint。它会对已有 tenant/project 组合执行 AGS agent 注册和 repo 权限授予,只写入非 secret 的 `.loom/control-plane/agent-git-service/provisioning.json` receipt,其中包含 `tokenEnvName` 和 `tokenMaterial: "returned-only"`;默认生成的 AGS agent token 只在响应里返回一次,不会落进 `.loom`,tenant audit/project activity 也只记录非 secret 证据。请求带 `"storeAgentToken": true` 时,服务端必须配置 `--agent-git-service-token-secret-root`,会把 token 写入服务端 secret root 并只返回 token-free `agentTokenSecret` 证据;后续 workspace prepare/clone、run/workspace command 和 workspace session 会以该 `tokenEnvName` 注入运行时 env,Coder git prepare 会用临时 `GIT_ASKPASS` 读取这个 env 做 clone/fetch/worktree/switch 认证,但持久化证据和 `.git/config` 仍不含 token 值。同一路径的 `GET` 只返回 receipt;重复 `POST` 默认返回 `409` 且不会再次调用 AGS,除非请求显式带 `"force": true`。它仍然不是自动 tenant cutover。

`GET /healthz` 是不需要鉴权的 liveness endpoint,用于部署探针;它只返回 `ok`、`startedAt` 和 `uptimeMs`。`GET /readyz` 是不需要鉴权的 readiness endpoint;启动时 stale-run cleanup 和 queued-run recovery 尚未完成或禁用前返回 `503`,ready 后返回 `200`,且只包含 readiness check 名称和实例时间。Smoke 会记录 `healthProbesChecked`、`readyzCheckNames` 和 `healthProbesSensitiveFieldsAbsent`,确认这些 probe 没有暴露 `resources`、`policy`、`workspaceRoot` 或 `tenants` 等只该出现在 status API 的字段。`GET /metrics` 会返回 Prometheus 风格的低基数 gauges,覆盖 readiness、active runs、queued runs、active workspace sessions、orphaned running runs、等待 review 的 run 数、等待 deployment approval 的 run 数、model usage warning project 数、workspace usage warning project 数、queued-run recovery 和 stale-run cleanup。它复用 global status 的访问规则:没有配置 tenant auth 时公开;一旦存在任何 tenant token 或 API key,就只允许 `admin` key 读取。Metrics 故意不带 tenant、project、run、actor 或 client labels;排障细节请用鉴权后的 status 或 tenant status。Smoke profile 和 `--check-metrics` 会把该 endpoint 解析为 numeric、unlabeled samples,一旦发现 tenant/project/token 文本或 labelled sample 就失败。`GET /status` 会返回 server 实例元数据(`workspaceRoot`、`startedAt`、`uptimeMs`)、profile readiness(`readiness.ok`、`readiness.missing`、per-check 细节和 `readiness.goldenPath` profile capability 标记)、`visionLock` 长期目标/能力标记、按共享 workspace root 跨 server 实例聚合的当前 active/queued run 数、带 workspace lease scope/key 证据的 active run 明细、同样跨实例聚合且带 project/run/actor/client 和 idle 生命周期字段的 active workspace session 明细、使用同一跨实例 active-run/session 视图的按 tenant active/queued/session 资源桶、重启后发现且没有 live admission claim 的 orphaned persisted running run 详情及 lease/stale 状态、queued run 详情、tenant/project queue position 和当前跨实例 blocked reason、启动时 stale run cleanup 审计计数/失败原因、启动时 queued recovery 的审计计数/失败原因、生效工具 allowlist 和资源限制;dashboard 的 Server 面板使用同一个接口,其中包含 run lease TTL、单 tenant active run cap,以及全局和单 tenant workspace session cap。`server.controlPlane.boundary` 会暴露 Gitea/Forgejo 和 `agent-git-service` 共用的 provider-neutral 边界:issue comments、signed webhooks、pull requests、merge、review-gate evidence、issue URLs、repo refs、source defaults、Git transport、workspace branch lease evidence、agent identity 和 backup/restore migration。`server.controlPlane.apiBasePath`、`discoveryEndpoints`、`nativeCapabilities` 和 `adoptionStages` 还会暴露 provider catalog 证据,例如 AGS 的 `/api/v3`、`/api/v3/meta`、`/api/v3/rate_limit`、durable agent identities、issue workspace presence、wiki memory,以及仍为 gated 的 `tenant-default-cutover` 阶段。`GET /tenants/:tenant/status` 是 viewer-readable 的 tenant-scoped status surface;它返回非敏感 profile `readiness`(含 `readiness.goldenPath`) 和 `visionLock`、该 tenant 的 effective `policy.allowedTools`、policy override 后的 active-run/workspace-session cap,以及仅该 tenant 的 active run lease、active/queued/session/orphaned run 明细,不暴露 `workspaceRoot`、跨 tenant bucket、全局 recovery audit 或 host runDir。
两个 status surface 都会暴露 `server.runWorkspaceIsolation`;如果不是 `run`,`platform-readiness` 会把 `readiness.checks.runWorkspaceIsolation` 标成缺口。它们也会在有 active run 时暴露 `resources.activeRunDetails`,其中每个 run 都带 `workspaceLeaseScope` 和可读的 `workspaceLeaseKey`(`tenant/project` 或 `tenant/project/runId`),让 operator 和后续 provider adapter 能看到 live workspace lease 拓扑。它们也会暴露 `server.runCreateIdempotency` 和 `readiness.checks.runCreateIdempotency`,覆盖调用方传入的 `clientRequestId`、共享 run store request record、跨 server replay、同时 create replay,以及 request 不匹配时返回 `409` 的行为。
`GET /tenants/:tenant/audit?after=<seq>&limit=<n>&project=<project>` 会返回 tenant 级 audit feed,持久化在 `<workspace-root>/<tenant>/.loom/audit.jsonl`;不传 `project` 时返回整个 tenant,传了则只返回该 project。`GET /tenants/:tenant/audit/stream?after=<seq>&project=<project>` 会用 SSE 以 `tenant_audit` 事件流式输出同样的过滤结果。这个 feed 会记录成功的 run create、project source/default-skill/run-policy/contract 设置更新、queued run 自动启动和完成、VAS case claim 变更、带可选 pause request 的 `run_comment_added`、run resume、cancel/abandon、run review claim、review/deployment decision、workspace file write/move/delete、workspace git commit、workspace PR handoff、workspace command、workspace session start/input/stop/exit,以及自动 stale-run cleanup。Async `run_finished` audit event 会在 model-backed run 上携带非 secret 的 `modelUsage`,并在 policy 阈值超出时携带 `modelUsageWarnings`。如果请求使用的是命名 tenant key,event 会包含 `actor` 和 `role`;可变 workspace 操作也可以带调用方提供的 `clientId`,用于关联浏览器 workbench tab 或 API client。Dashboard 的 Server 面板和 focused workbench 都会加载并订阅 tenant audit stream,把非 secret 的 policy diff 和 policy member create/revoke 证据渲染成可读摘要,并用匹配事件静默刷新 Dashboard project summary/backlog/warning/run/file/command/session/follow-up-lineage 或 Workbench run/replay/review-summary/handoff-package/file/command/session/follow-up-lineage 视图,且不清空当前 command error 或在临时失败时替换已加载的 replay、evidence panel 或 lineage。
Tenant audit 也会记录 `tenant_control_plane_restore_dry_run`,包含 provider、source/target provider、format、project 名称、project/run 数、missing/extra project 数、audit checkpoint 数和 secret-scrub 证据。Project summary 会把这条事件作为每个 dry-run manifest 内项目的 `latestControlActivity` 暴露出来。
Workbench replay 对 gate/control 类 audit event 会和 run summary 一起刷新,避免多人 review/deploy/cancel/resume 时只更新状态而 timeline 留在旧版本。
Dashboard selected-run replay/review-summary 也会跟随同类 audit event 刷新,覆盖多人 review/deploy/cancel/resume/PR handoff/follow-up 的控制面操作。
`GET /tenants/:tenant/control-plane/backup` 会返回 admin-only、非 secret 的 tenant backup/migration manifest,包含 schema version、generated time、当前 control-plane provider boundary、脱敏后的 tenant policy 加 API key count、audit checkpoint、project summary 和每个 project 的轻量 run metadata。它不会包含 workspace 文件内容、API key token、token hash 或模型 key 值;从默认 Gitea/Forgejo 路径迁移到其他 provider 前,可以把它作为可移植的控制面 manifest。

`GET /tenants/:tenant/control-plane/cutover-readiness?targetProvider=agent-git-service` 是 admin-only、只读的 `tenant-default-cutover` readiness 快捷入口。它返回和 AGS-target restore dry-run 相同的非 secret `cutoverReadiness` 形状,包含 project-agent receipt/secret 计数和缺失 project refs,不需要 backup manifest,也不会写 audit。Dashboard Server 面板可以在 AGS tenant plan 控制旁直接加载同一个 gate。

`POST /tenants/:tenant/control-plane/restore-dry-run` 接收这份 manifest,返回 admin-only、不会写入状态的 restore/migration 校验摘要。加 `?targetProvider=<provider>` 可以在 tenant 切换前,用当前 manifest 校验另一个 serve-enabled catalog provider;例如默认 Gitea/Forgejo manifest 可以校验到 `agent-git-service`,agent-git-service manifest 也可以校验回 `gitea-forgejo`。它会检查 schema version、route tenant、source provider、target provider boundary、完整 manifest boundary、project entries、run ids、audit checkpoint 和 secret scrubbing;响应包含 `applied: false`、`sourceProvider`、`targetProvider`、预期 project 名称、预期 run 数、missing/extra project 名称,让 provider 迁移可以先 dry-run 再切换 tenant 状态。当目标是 `agent-git-service` 时,响应还会包含 gated `tenant-default-cutover` 阶段的非 secret `cutoverReadiness`,包括 `agentGitServiceProjectAgents` receipt/secret 计数和缺失 project refs。成功 dry-run 会追加非 secret 的 `tenant_control_plane_restore_dry_run` audit event。

`GET /tenants/:tenant/projects` 会列出租户下发现到的 project 目录,以及 `runCount`、最新 run 状态、可能存在的 project `template`、项目源码默认值(`repo`、`branch`、`baseBranch`、`issue`)、`defaultSkills`、`runPolicy`、`contract`、`contractStatus`、`runningRunId`,有 project command 时会带 `latestWorkspaceCommand`,有 project terminal session 时会带 `latestWorkspaceSession`,有 project-scoped file/commit/PR audit 活动时会带 `latestWorkspaceActivity`,有 project-scoped comment/issue-sync/resume/cancel/abandon/review/deployment/handoff audit 活动时会带 `latestControlActivity`,有 active workspace session 时会带 `activeWorkspaceSessionDetails`,有在线 Dashboard 协作者时会带 `activeProjectCollaboratorCount` 和 `activeProjectCollaborators`,有在线 run workbench 协作者时会带 `activeRunCollaboratorCount` 和 `activeRunCollaborators`,有排队 backlog 时还会带 `queuedRunCount`、`queuedRunIds` 和带 tenant/project queue position 与 blocker 细节的 `queuedRuns`,有待人工 gate backlog 时还会带 `reviewRequiredRunCount`、`reviewRequiredRunIds`、`reviewRequiredRuns`、`deploymentRequiredRunCount`、`deploymentRequiredRunIds` 和 `deploymentRequiredRuns`,有 model-backed run 用量时会带项目聚合 `modelUsage`、按 requester 聚合的 `modelUsageByRequester` 和 policy 阈值触发的 `modelUsageWarnings`,有 workspace byte policy 时会带 `workspaceBytes`、`workspaceByteLimit`、`workspaceByteWarningThreshold` 和 `workspaceByteWarnings`,并为 `vas-lite` project 聚合 VAS readiness(`vasCaseCount`、`vasNeedsReviewCaseCount`、`vasReviewedRunCount`、`vasUnreviewedRunCount`),方便控制面先找到 active/online/queued/orphaned/changed/待 review/待 deploy/模型消耗较高/workspace 偏重/contract 漂移/最近有人控动作的 project,再打开 run 历史。Gate run detail 会包含 run id、goal、状态、开始时间、源码元数据、requester、gate 状态,以及存在时的 review claim。`POST /tenants/:tenant/projects` 会用 `{ "project": "proj-a", "template": "empty" | "vas-lite", "repo": "team/proj-a", "branch": "task/proj-a-123", "baseBranch": "main", "issue": "team/proj-a#123", "clientId": "..." }` 创建 tenant project 目录;配置 auth 时要求 `developer` 权限,源码默认值会存在 tenant 控制面元数据里而不是写进项目文件树,成功返回 project summary,并写入 `project_created` tenant audit event。`PUT /tenants/:tenant/projects/:project/source-defaults` 会用 `{ "repo": "...", "branch": "...", "baseBranch": "...", "issue": "...", "clientId": "..." }` 更新这些源码默认值;空字符串会清掉对应字段,全空 body 会删除已保存的默认值,并写入 `project_source_defaults_updated` audit event。后续 `POST /runs` 如果没有显式提供同名字段,会继承该 project 当前的源码默认值。默认 `empty` 保持旧的空目录行为;`vas-lite` 会 seed 一个轻量文件式视频分析系统骨架,包含 `cases/`、`vocabulary/`、`src/loop.js`、`package.json` 和 `.loom/project.json` 元数据,并 seed 一份 project contract,把多用户在线沙箱、harness loop、人审 gate、持久 evidence 和 VAS learning loop 这些初始目标留在 MVP 之后。模板自带的 `bootstrap` case 会继承创建项目时给出的源码默认值,让在线沙箱创建后就带一个可继续跑的领域 loop。`GET /tenants/:tenant/projects/:project/vas/cases` 会列出 `cases/<caseId>/case.json` 派生的 case summary,包含有效 repo/branch/baseBranch/issue 元数据;如果某些显示出来的源码字段来自 project defaults 而不是 case 文件,会返回 `sourceDefaultFields` 标记来源。它也会从 `.loom/runs` 和 case reviews 补上匹配 `vas-lite-review` run 的 `runCount`、最新 run id/status/time,以及 review coverage(`reviewedRunCount`、`unreviewedRunCount`、最新 run review decision/time),让 Dashboard 能从 case 直接看到最新 loop 是否还缺人工复核。`POST /tenants/:tenant/projects/:project/vas/cases` 创建 case 时,如果 body 没有提供 repo/branch/baseBranch/issue,会先继承项目源码默认值,再写入 case 文件和 `vas_case_created` audit。`GET /tenants/:tenant/projects/:project/vas/cases/:caseId/runs` 会按最新优先返回该 case 的完整 `vas-lite-review` run history,包含 run id、状态、goal、起止时间、agent mode、issue/summary link 和标准化 preset input。`POST /tenants/:tenant/projects/:project/vas/cases/:caseId/review-runs` 是 case 级启动入口,会创建 async queued 的 `vas-lite-review` run;配置 auth 时要求 `developer` 权限,返回 `202` 的 running/queued status,body 未提供 repo/branch/baseBranch/issue 时会继承 case 上的默认值,并复用 `POST /runs` 的 model/tool 字段和 `run_created` audit。`POST /tenants/:tenant/projects/:project/vas/cases/:caseId/review` 可带 `{ "decision": "approved" | "changes_requested", "note": "...", "corrections": ["..."], "learnings": ["..."], "runId": "<matching-vas-lite-review-run>", "clientId": "..." }`;如果传了 `runId`,服务端会确认它属于当前 case,并把该 run id 写入 review、corrections、learnings、audit 和 learned-patterns。`POST /runs` 可对 `vas-lite` project 传 `{ "tenant": "alice", "project": "proj-a", "preset": "vas-lite-review", "presetInput": { "caseId": "bootstrap" } }`;`caseId` 默认是 `bootstrap`,且必须存在 `cases/<caseId>/case.json`。preset 会补默认 goal、scripted agent steps、`node src/loop.js status` verification 和 `["vas-lite", "coding"]` skills,除非请求显式覆盖,然后写入 `cases/<caseId>/reports/latest.md`,并记录 `metadata.runPreset` 和 `metadata.runPresetInput`。
项目创建以及 source defaults、default skills、run policy 和 contract 更新也会进入 `latestControlActivity`,所以 project card 能直接显示最近一次控制面变更的 actor/client 证据。
项目模板元数据可以带 `defaultSkills`;`vas-lite` 默认写入 `["vas-lite", "coding"]`。Project summary 会暴露存在的默认 skills,普通 `POST /runs` 和 `vas-lite-review` preset 在请求未显式传 `skills` 时都会继承它。`PUT /tenants/:tenant/projects/:project/default-skills` 接收 `{ "defaultSkills": ["vas-lite", "coding"], "clientId": "..." }`,配置 auth 时要求 `developer` 权限,写入 `.loom/project.json`,返回刷新后的 project summary,并记录 `project_default_skills_updated` audit 证据;空数组表示显式关闭项目默认 skills。
项目元数据也可以带 `runPolicy`,包含 `preset`、`presetInput.caseId`、`reviewRequired` 和 `deploymentRequired`。`PUT /tenants/:tenant/projects/:project/run-policy` 接收这些字段和 `clientId`,配置 auth 时要求 `developer` 权限,把压缩后的策略写入 `.loom/project.json`,返回刷新后的 project summary,并记录 `project_run_policy_updated`;空策略会清掉项目默认。后续 `POST /runs` 和 async project run 入口只在请求未显式提供对应字段时继承这些策略字段,所以单次 run 里的显式 `false`、preset 或 presetInput 仍然优先。被项目策略补齐过的 run 会在非 secret 的 `metadata.projectRunPolicy` 里记录继承了哪些字段和值,`run_created` audit 也会带同一份证据,供 Dashboard、review package 和 handoff 阅读。
项目元数据也可以带 `contract`,包含 `objective`、`constraints` 和 `successCriteria`。`PUT /tenants/:tenant/projects/:project/contract` 接收这些字段和 `clientId`,配置 auth 时要求 `developer` 权限,把压缩后的 contract 写入 `.loom/project.json`,返回刷新后的 project summary,并记录 `project_contract_updated`;空字符串和空数组会清掉 contract。Project summary 也会在 contract 存在或模板要求 contract 时返回 `contractStatus`。对 `vas-lite` 来说,这个状态会检查 contract 是否仍包含 multi-user online sandbox、harness loop、人审 gate、durable evidence 和 VAS learning 标记;如果漂移,smoke 会在启动 run 前失败。后续 run 会把当时的 contract 和 status 快照写入非 secret 的 `metadata.projectContract` / `metadata.projectContractStatus`;当 status 已漂移时,创建 run 会强制进入 review gate,即使请求显式省略这个 gate。approved review decision 可以带 `contractPatch`,把修复后的 contract 写回 project metadata 并审计 `project_contract_updated`;rejected decision 只把 patch 留作 review evidence,不改变项目。Dashboard 和 Workbench 的 review 表单也暴露同一组 patch 字段,并会在 review summary 里显示已记录的 patch。`run_created` audit 也会带同一份证据;handoff follow-up run 会把源 run 快照复制到 `metadata.handoffSourceProjectContract` / `metadata.handoffSourceProjectContractStatus` 和 lineage evidence,让 agent、reviewer 和 handoff reader 在 MVP 演进后仍能看到项目最初目标和漂移状态。
VAS review preset 的 `context.json` 会同时带跨 case 的 approved prior learnings 和当前 case 有界的 `reviewGuidance`。后者来自当前 case 的最近 reviews/corrections/learnings,并把 `priorLearningCount`、`reviewCount`、`correctionCount`、`caseLearningCount` 写进 `metadata.runPresetInput`,让 `changes_requested` 后的下一轮 review run 能直接吃到人类反馈。
项目级 workspace、file、command、terminal session、diff、commit 和 PR executor context 会在没有 run 级覆盖时继承项目 `repo`、`branch` 和 `baseBranch` 默认值;项目级 PR handoff 也可以从 project source defaults 默认取得 `issue`、`branch` 和 `baseBranch`。当 `runWorkspaceIsolation` 是 `run` 时,run-scoped workspace 操作会把 run id 纳入 active-workspace lock,所以一个 run 的 file/command/session/commit/PR 操作可以在同项目另一个 run 仍在其它 worktree 活跃时继续进行;文件写入、移动、删除这些可变路由仍会和同一个 active run 串行化。run-scoped PR handoff 如果没有显式传 `branch`,会从 run metadata 或 project defaults 派生 `<fallback>/<runId>`,避免同项目并发 run 推到同一个 review branch;请求里显式传入的 `branch` 不会被改写。Workspace diff 和 checkpoint commit 都会刻意排除 `.loom`,所以 run log、audit、session 和控制面元数据不会漏进 review branch。
`GET /tenants/:tenant/model-usage/warnings` 返回 `{ tenant, projects }`,其中 `projects` 复用 `ProjectSummary` 结构,只保留当前触发 policy 模型用量 warning 的 project;`GET /tenants/:tenant/workspace-usage/warnings` 同样返回当前触发 workspace byte warning 的 project。Dashboard 会把它们作为 warning 队列加载,并在相关 audit 或 policy 阈值保存后刷新。

`GET /tenants/:tenant/projects/:project/files?path=<relative-path>` 会通过配置的 executor 浏览当前 tenant/project 的 live workspace 文件树,并读取小型文本文件。`POST /tenants/:tenant/projects/:project/files` 用 `{ "path": "...", "content": "...", "baseUpdatedAt": "...", "clientId": "..." }` 通过同一个 executor 边界新建或保存小型 UTF-8 文本文件;如果配置了 `limits.maxWorkspaceBytes`,保存会按写入后的非 `.loom` workspace 内容大小拒绝超限。`POST /tenants/:tenant/projects/:project/files/move` 用 `{ "fromPath": "...", "toPath": "...", "baseUpdatedAt": "...", "clientId": "..." }` 移动单个文件,拒绝覆盖已存在目标,并写入 `workspace_file_moved`;`DELETE /tenants/:tenant/projects/:project/files?path=<relative-path>` 会先确认目标是文件而不是目录,再删除并写入 `workspace_file_deleted` audit event。如果 `baseUpdatedAt` 来自上一次读取且文件已被别人更新,服务端会对过期保存、过期移动和过期删除返回带同文件 active editors 的 `409`,不会覆盖、移动或移除新内容,workbench 会提供 reload-latest 动作用于恢复。当 presence focus 显示其他协作者也在同一个 `file:<path>` 上时,文件编辑器标题会先显示这些名字,让冲突在保存前就可见。要查看、新建、编辑、移动或删除某一次 run 的 workspace,用 `GET`/`POST`/`POST .../files/move`/`DELETE /tenants/:tenant/runs/:runId/files?project=<project>&path=<relative-path>`,写入、移动和删除同样支持这个可选的 stale guard;`GET /tenants/:tenant/projects/:project/diff` 和 `GET /tenants/:tenant/runs/:runId/diff?project=<project>` 会通过 `git.diff` 返回排除 `.loom` 的有界 workspace git diff 结果,不要求开启 `shell.exec`;`POST /tenants/:tenant/projects/:project/commits` 和 `POST /tenants/:tenant/runs/:runId/commits?project=<project>` 会通过 `git.commit` 用 `{ "message": "...", "clientId": "..." }` 创建可审计的本地 git checkpoint;`POST /tenants/:tenant/projects/:project/pull-requests` 和 `POST /tenants/:tenant/runs/:runId/pull-requests?project=<project>` 默认把 `HEAD` push 到指定或默认 branch,并通过 `git.pr` 加 `--control-plane-pr` 用 `{ "issue": "owner/repo#42", "branch": "...", "baseBranch": "...", "reviewRequired": true, "clientId": "..." }` 创建可审计的 provider PR handoff;project-scoped handoff 可以从 project source defaults 默认取得 `issue`/`branch`/`baseBranch`,run-scoped handoff 可以从 run metadata 默认取得这些字段,在 run-scoped workspace isolation 下还会在请求省略 `branch` 时派生带 runId 后缀的分支,默认 PR body 也会带 requester、run evidence 链接和 verification/evaluation/reviewer 摘要,并能把已 passed 的 run 拉回 `review_required`;`GET /tenants/:tenant/runs/:runId/handoff-package?project=<project>` 会把产生的 review 证据、workspace 上下文、结构化 changed-file 提示、command/session 摘要、commit/PR handoff 字段、链接和 audit trail 打成一个人工 review 包;`POST /tenants/:tenant/runs/:runId/commands?project=<project>` 会在同一个 run workspace 里执行允许的 shell 命令,并把 command summary 记录到该 run 下。服务端会把该 run 的 repo/branch 元数据传给 executor,让 Coder worktree 上下文保持一致。路径会被限制在项目 workspace 内,`.loom` 内部数据仍通过专用 run API 访问。

同一个 handoff package 会带上 run 派生的 `messages`、`gateTrail`、`externalEffects`、初始 linked issue context sync 以及 handoff follow-up 启动/拒绝等 issue command outcome 的 `issueCommentSeeds`、已有子 run 的 `followupRuns[]` 和 `links.followupRuns`,把人类上下文、review/deployment gate 变化、外部副作用、可继续执行入口和 client/actor/requester 证据放进交接包;如果 follow-up 来自 Gitea/Forgejo 评论,子 run 证据还会带触发它的 `giteaCommentId` 和 `giteaCommentUrl`。由该入口创建的 follow-up run 也会把源 run 的有界 changed-file、command、session evidence 写进初始 seed。直接 API/浏览器启动的 follow-up 默认继承源 run 的 `model` 和非默认 `modelProtocol`,除非请求体显式覆盖;issue comment 启动的 follow-up 也会继承同样字段,让 tool-call 模型接力保持同一协议。
Issue comment 同步和 webhook 响应里的 `startedHandoffFollowups[]` 也会在 `/loom run-handoff-followup` 启动子 run 时返回 child run id/status、source checkpoint version、workbench/handoff-package 链接,以及触发它的 Gitea/Forgejo comment id/url。Handoff package 和 lineage 响应也会在 `issueCommentSeeds[]` 与 `followupRuns[]` 上保留同一个 source checkpoint,让浏览器 evidence panel 能直接显示每个外部 follow-up 来自哪个源证据版本。`run_handoff_followup_denied` 通过 tenant audit 到达时,Dashboard 和 Workbench 也会静默刷新已加载的 follow-up lineage,让被拒绝的接力尝试推进 evidence checkpoint,而不是让面板停在旧状态。
`GET /tenants/:tenant/projects/:project/vas/cases/:caseId/runs` 会在顶层返回该 case 的有效 repo/branch/baseBranch/issue 和 `sourceDefaultFields`;每条 run entry 还会返回相对 `reviewSummaryUrl`/`handoffPackageUrl` reviewer 链接、PR link 元数据、run-level review/deployment gate 状态、失败 kind/focus 和有界 public error diagnostics、从 run event log 派生的 VAS artifact 路径和 context/report/review draft 写入标记,以及该 run 的人工 review 状态、decision、reviewer、review client id 和 reviewed timestamp,让 Dashboard/Workbench 的 case run history 能直接区分 reviewed 与 unreviewed,也能看到 PR/gate/artifact 结果。
`GET /tenants/:tenant/projects/:project/vas/review-queue` 会返回需要人工关注的 viewer-readable case summary:有未复核 run、`needs_review` 或 `needs_revision` 的 case,并附带 review package、runs、artifacts、review 和下一轮 review-runs 链接。
`POST /tenants/:tenant/projects/:project/vas/cases/:caseId/claim` 允许 developer/admin 用 `{ "action": "claim" | "release", "clientId": "..." }` 对 case 做 soft claim 或释放;claim 会显示在 case summary/review package 并写入 `vas_case_claimed` audit,但不会阻塞 review。Claim 被接手时会在 audit 中记录上一个 `previousClaim`,让 VAS review queue ownership 可观察但仍保持 soft。

VAS case 创建、claim 和 review audit 也会进入 project `latestControlActivity`,所以 project card 能和 run 控制动作一起显示最近的 VAS 队列 ownership、takeover 证据和 review 进展。
`GET /tenants/:tenant/projects/:project/vas/cases/:caseId/review-package` 会把 case summary、当前 artifacts、完整 run history、reviews、corrections、learnings、reviewer links、`issueCommentSeeds` 和按 case 过滤的 tenant audit trail 打成一个 viewer-readable 包,供 Dashboard/Workbench 做人工复核交接。VAS review-run 的 issue-comment seed audit 会带同一个 `presetInput.caseId`,所以 review package 里能直接看到启动时同步了多少外部 issue 上下文。
`POST /tenants/:tenant/projects/:project/vas/cases/:caseId/review-runs` 除了可以覆盖 case 默认的 repo/branch/baseBranch/issue 和 model/modelProtocol/tool 字段,也会在 body 未传 `reviewRequired` 或 `deploymentRequired` 时继承项目 `runPolicy` gate 默认值;body 里的 `pullRequest`、`reviewRequired`、`deploymentRequired` 和 `syncIssueComments` 仍然优先透传,让 case-scoped VAS review run 同样能产出 PR、停在人审或部署 gate,并在启动前把 linked issue comment seed 进新 run log;开启 seed 时会写入带 `initial: true` 的 `run_issue_comments_synced` audit。
`POST /tenants/:tenant/projects/:project/commands` 会运行一次性 workspace command,并返回 `{ commandId, stdout, stdoutBytes, stdoutTruncated, stderr, stderrBytes, stderrTruncated, exitCode }`,配置命名 tenant key 或传入 `clientId` 时还会带 `actor`、`role`、`clientId`。它要求服务端 allowlist 包含 `shell.exec`,所以只在隔离沙箱 workspace 里用 `--allow-shell` 开启。如果配置了 `limits.maxWorkspaceBytes` 且当前非 `.loom` workspace 内容已达到或超过上限,command 会拒绝启动。请求里可选的 `timeoutMs` 只能缩短 command timeout,不能超过服务端 `--workspace-command-timeout-ms` 上限,默认是 120 秒;也可以带 `clientId` 用于 audit 和 command history 关联。`GET /tenants/:tenant/projects/:project/commands` 和 `GET /tenants/:tenant/runs/:runId/commands?project=<project>` 会按最新优先列出持久化 command summary,并保留同样的请求身份字段。
`POST /tenants/:tenant/projects/:project/sessions` 会用 `{ "command": "sh", "clientId": "..." }` 启动一个持久 workspace session;`POST /tenants/:tenant/runs/:runId/sessions?project=<project>` 会在某次 run/worktree 上下文里启动同类 session。如果配置了 `limits.maxWorkspaceBytes` 且当前非 `.loom` workspace 内容已达到或超过上限,session 会拒绝启动。`GET .../sessions` 会列出 active 和历史 session,并在可用时带上启动者的 `actor`、`role`、`clientId`、`lastActivityAt`、`idleExpiresAt`;`GET .../sessions/:sessionId/events` 用于读取持久 transcript,`GET .../events/stream` 用于 SSE,`POST .../input` 写 stdin,`POST .../stop` 终止 session。Start、input、stop transcript event 会在可用时记录 actor/role/client 元数据;exit event 会记录 `exitCode` 和可选 `signal`,并同时写入 `workspace_session_exited` tenant audit 以驱动 Dashboard/Workbench 刷新。浏览器 Dashboard/Workbench 的 session stream 会保留 EventSource,让原生 `Last-Event-ID` 自动重连持续工作,直到 session exit 或用户显式切换/reset session。已接受的 stdin 写入只记录字节数,不会记录原始输入文本。JSON 请求体上限是 1 MB,session input 单段上限是 64 KiB,active workspace session 默认在共享同一个 workspace root 的多个 server 实例之间总计最多 32 个,通过 `.loom/admission/workspace-sessions` 下带 lease 的 claim 生效;单 tenant active session cap 默认等于全局 cap,也可以用 `--max-tenant-workspace-sessions` 调低,且这个单 tenant cap 会通过 `<tenant>/.loom/admission/workspace-sessions` 下带 lease 的 claim 跨 server 实例生效。同一批 claim 也会让远端实例中的 running session 在 project/session list 里保持 active 可见,没有当前 claim 的 running summary 则视为 orphaned。Idle session 默认 30 分钟后 stop,process-backed session 停止时会先 SIGTERM,5 秒 grace 后仍未退出则 SIGKILL,持久化 command stream 和 session output event 会按每段 64 KiB 截断,API 会保留原始字节数和截断标记。

`loom harness serve` 启动时带上模型配置后,HTTP 调用方可以传 `"model": "kimi-k2.6"` 来替代 `script` 或 `agentCommand`;对偏好 Chat Completions tool calls 的 provider,可传 `"modelProtocol": "tool-call"` 或启动服务时加 `--model-protocol tool-call`。Dashboard 也暴露同一个 model protocol 选择器。如果 tenant policy 或 `--tenant-model-key` 配了 tenant 专属 env,该 run 会用 tenant key;否则回退到服务端全局 `--model-key-env`。

HTTP 模式默认拒绝 `shell.exec`。默认允许的 action tools 是 `file.read`、`file.write`、`git.diff`、`git.commit`、`verify.run`;只有在隔离 workspace 里才加 `--allow-shell` 或重复使用 `--allow-tool <name>`。Workspace PR handoff 是外部副作用,还需要 `--control-plane-pr` 和 `--allow-tool git.pr`;Dashboard/Workbench 的 PR handoff 控件可以在缺少该工具时提交定向 `git.pr` escalation request。请求可以带 `"allowedTools"` 进一步收窄单次 run 的工具面,但它必须是服务端 allowlist 的子集,否则请求会以 `400` 失败。最终生效的工具策略会作为 `run_policy` 写入事件日志。

一旦配置了 `--tenant-token tenant=token`、`--tenant-key-env tenant=ENV:actor:role` 或 `--tenant-key tenant=token:actor:role`,该 tenant 的所有 API 都要求 `authorization: Bearer <token>` 或 `x-loom-tenant-token: <token>`。事件流也接受 `?token=<token>`,因为浏览器 `EventSource` 不能发送自定义 header。`viewer` key 可以读取 tenant 资源、添加 run comment、请求 active run pause,并申请 policy escalation;`developer` 和 `admin` key 可以创建 run、恢复 paused run、新建/编辑/移动/删除文件、创建 git checkpoint、在允许 `git.pr` 时发起 workspace PR handoff、运行 command、控制 session、cancel/abandon run、对 pending run review 做 claim/release,以及提交 review decision;只有 `admin` 可以更新 tenant policy、审批 escalation request、审批或拒绝 deployment gate。签名 Gitea `/loom resume`、`/loom approve`、`/loom request-changes`、`/loom claim-review`、`/loom release-review-claim`、`/loom approve-deploy`、`/loom reject-deploy`、`/loom approve-vas`、`/loom request-vas-changes`、`/loom claim-vas`、`/loom release-vas-claim`、`/loom run-vas-review` 和 `/loom run-handoff-followup` 评论会从匹配的 tenant key actor(例如 `gitea:alice` 或 `alice`)继承 role;未映射评论者保持 `viewer`。Approved escalation 只合并请求的 tools/limits,不会改掉已有 `modelKeyEnv`、`executorTemplateParameters` 或 API key actor,并在 escalation/audit 里记录非 secret 的 `policyChange.allowedTools.before/after/added` 与 `policyChange.limits.before/after/changed`。Tenant audit event 会记录匹配到的 `actor` 和 `role`,不会记录 token。

## VPS 多租户(loomd)

`loomd` 在上面加一层多租户。它管**鉴权 + 开容器 + 生命周期 + brain 宿主**;**不协调矩阵**(仍靠共享 Gitea 看板涌现)。每个租户都可以在自己的容器里跑自建 harness 或原生 `/goal` 适配器。
租户名必须匹配 `[A-Za-z0-9][A-Za-z0-9_.-]{0,62}`,因为同一个名字会进入 registry、Docker container/volume 名和 host 侧 activity marker。

```bash
loomd user add alice --auth subscription          # alice 用她自己的席位
loomd user add bob   --auth gateway --key-env LOOM_KEY_BOB
loomd serve --interval 30 &                        # 后台:本地 brain 分支 + 空闲 GC
# 或者,共享 Gitea skills repo 时:
loomd serve --interval 30 --git-sync --gitea-pr --gitea-repo team/_skills --gitea-token-env LOOM_GITEA_TOKEN &
# SSH 入口:authorized_keys 每个 key 绑一个租户 →
#   command="/usr/local/bin/loom-ssh-forcecommand alice",... ssh-ed25519 AAAA... alice
# 用 alice 的 key `ssh loom@vps` → loomd enter alice → exec 进她的容器
```

`--git-sync` 会让每次 brain tick 先对 `skillsRepo` 执行 `git fetch <remote> --prune` 和 `git pull --ff-only <remote> <base>`,中心 `loomd` 才能看到租户 workspace 推上来的信号。它复用 `--git-remote` 和 `--gitea-base` 作为 remote 和分支;pull 前只会清理可由本地 signals 安全再生成的 `.brain/skill_evals.json`。

`loomd enter` 会在租户 SSH shell 连接期间写 active session marker,退出时更新 `lastActiveAt`。`loomd serve` 只会停止没有 active marker 且空闲超过 `idleStopMinutes` 的租户容器;卷会保留。用 `--no-idle-gc` 可以关闭清理。

`loomd ps` 会同时显示 Docker 状态和 `ACTIVE_SESSIONS`、`LAST_ACTIVE`、`IDLE_FOR`,VPS 管理员能看出容器是在忙、已停,还是可以清理。

### 隔离分级(配置项 `runtime`)
- `runc` —— 纯 Docker + 命名卷 + `--cap-drop ALL` + 资源限额 + 网络策略(租户之间不通)。
- `runsc` —— **gVisor(默认)**。syscall 级沙箱;agent 带 bypass 跑任意代码,正合适。
- `kata-fc` —— Firecracker microVM。需要 VM 级隔离时上。

每租户:独立容器、独立持久卷(`loom-home-<user>` → `/home/dev`)、独立 `~/.claude`。**持久卷正是原生 `--resume` 能按租户跨 session 续上的原因。**

### Auth 模式(按租户)
- `gateway` —— loomd 注入 `ANTHROPIC_BASE_URL`(LiteLLM)+ 该租户的虚拟 key。按量、中心计费、每人预算。
- `subscription` —— loomd **什么都不注入**。租户在**自己的**容器里 `claude login` 一次,登录态只留在自己卷里。**一人一席。** loomd 不存、不拷、不跨租户共享任何订阅凭证——**没有共享订阅的代码路径**,而且按租户隔离让登录态不可能在租户间泄漏。

## 三条护栏(别删)

1. **验证归你** —— `/goal` 说「done」是声明,不是证明。
2. **读 loop 写的代码** —— 理解债会无声地复利。
3. **设计 loop 是为了更快做你懂的事,不是为了逃避去懂它。**
