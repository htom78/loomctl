# loomctl

多用户在线沙箱开发平台的操作 CLI + HTTP 控制面,自带第一方可审计 harness loop。

两条 loop 路径:

1. **自建 harness loop** —— `loom harness run`:事件日志、工具运行时、agent 适配器、验证门禁收尾。
2. **原生适配器** —— `loom goal` 委托 Claude Code / Codex `/goal`,保留薄模式。

平台形态:

- **多用户在线沙箱开发** —— 每人持久 workspace、项目、租户隔离。
- **共享控制面** —— 默认 Gitea/Forgejo 看板,`agent-git-service` 为候选 provider,中心 LiteLLM 模型网关。
- **技能自演化 brain** —— 抓 run 信号、给技能打分、开 git-backed 改进 PR。

## 核心保证

- 事件溯源的 run 历史:`.loom/runs/<runId>/events.jsonl`,人类可检查、可回放;每个 run 单调序列、原子 append。
- **验证是硬门禁,不是模型自述**。可选 evaluator 命令在验证后追加门禁;可选 reviewer 命令只记录证据不代替人。人工 review / 部署门禁独立于两者。
- 租户级认证(API key 或 OIDC),HTTP 侧 `shell.exec` 默认拒绝,每 run 工具白名单落成可审计的 `run_policy` 事件。
- run 摘要 / issue 评论 / PR 正文携带请求者身份和有界的非敏感错误诊断;API key 永不写入摘要。

## 快速开始

```bash
npm install
npm run build
npm link          # 得到 `loom` 命令
```

用脚本化 agent 跑一次 harness(示例见英文 README Quickstart),产物在
`.loom/runs/<runId>/` 下。

本地配置:复制 `loom.config.example.json` 为 `loom.config.json`。凭据放环境
变量或外部 secret store,本地配置和生成的 operator 报告已被 Git 忽略。

## HTTP 服务

```bash
loom harness serve --workspace-root /tmp/loom-workspaces --port 8787
```

- 异步 run、排队、取消/暂停/恢复、`clientRequestId` 幂等创建、SSE 事件流、浏览器 dashboard/workbench。
- `--profile online-sandbox` 在线沙箱工具白名单;`--profile platform-readiness` 完整平台就绪检查(`GET /status`)。
- **local executor 只用于 loopback 单人开发**。`serve` 会拒绝认证 + 非 loopback + 开 shell 的 local executor 组合,除非显式传 `--allow-unsafe-local-executor`。共享部署一律用 Docker 或 Coder executor。

多实例部署用 Postgres(持久元数据/审计)+ Redis(租约/队列):

```bash
LOOM_POSTGRES_URL='postgres://loom:secret@postgres/loom' \
LOOM_REDIS_URL='redis://redis:6379' \
loom harness serve --workspace-root /data/workspaces --state-backend postgres-redis
```

语义见 [docs/distributed-runtime.md](docs/distributed-runtime.md);两实例验证:
`npm run staging:up` / `staging:smoke` / `staging:down`。

对外服务前先用同样的 flags 跑 `loom harness doctor`,再按
[docs/operator-runbook.md](docs/operator-runbook.md) 走。

## 文件地图

| 部件 | 位置 |
|---|---|
| 第一方 loop | `src/harness/loop.ts` |
| HTTP 控制面 | `src/harness/server.ts` |
| 执行边界 | `src/harness/executor.ts`(local)、`docker-executor.ts`、`coder-executor.ts` |
| 控制面 provider | `src/harness/gitea.ts`、`src/harness/agent-git-service.ts` |
| 模型网关适配器 | `src/harness/model-agent.ts` |
| 状态后端 | 默认 file;分布式 `src/harness/storage/postgres.ts` + `redis.ts` |
| brain | `src/brain.ts` |
| 灾备 | `loom platform-backup / restore / drill`,[docs/disaster-recovery.md](docs/disaster-recovery.md) |

## 测试

```bash
npm test
```

真实 Postgres/Redis 集成测试需要设置 `LOOM_TEST_POSTGRES_URL` 和
`LOOM_TEST_REDIS_URL`,否则自动跳过。

Full English documentation: [README.md](README.md)
