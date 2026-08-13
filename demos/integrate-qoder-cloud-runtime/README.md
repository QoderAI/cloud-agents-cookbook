# 接入 Qoder Cloud 运行时 Demo

一个自包含的 Go 模块，演示如何把业务能力以客户端自定义工具的形式安全回接给 Qoder Cloud Agent：白名单分派器（校验 + 任务范围）、`requires_action` 整批协议（exactly-once + 重放不重复执行 + fail-closed），以及带 `Last-Event-ID` 续传和去重的 SSE 读取器。纯 Go 标准库，无第三方依赖。

## 对应文章

- 标题：把 Qoder Cloud 接成你自己系统里的一名“员工”
- Slug：`integrate-qoder-cloud-runtime`

## 关于来源

这个模式提炼自 [Multica](https://github.com/multica-ai/multica) —— 一个开源的多 Agent 协作工作台，它把 Qoder Cloud 作为其中一种 Agent 运行时接入。本目录是把那套集成里最关键的协议部分（分派器 + 整批协议 + SSE 续传）提炼成一个能独立编译、能跑测试的最小模块，方便研读和复用。完整的产品与周边实现见 Multica 项目本体。

## 前置条件

- Go 1.22 或更高版本。
- 无第三方依赖，无需网络：所有测试用进程内 fake store 与 `httptest` mock 服务端运行。

## 安装与配置

无需额外配置。模块路径为 `example.com/qoder-cloud-runtime-demo`，仅依赖 Go 标准库。

```bash
go mod verify
```

## 运行

运行完整测试套件：

```bash
go test ./...
```

在支持 cgo 的环境上可开启竞态检测（对应文章推荐的做法）：

```bash
CGO_ENABLED=1 go test -race ./...
```

## 验证结果

`go test ./...` 应全部通过，覆盖以下行为：

| 测试 | 验证的行为 |
|---|---|
| `TestDispatchRejectsInvalidInput` | 未知工具、未知字段、非 UUID、非法枚举、空更新一律在触达业务前被拒 |
| `TestDispatchEnforcesIssueScope` | 工单任务只能读写被指派的那个工单 |
| `TestBatchRunsOnceThenReplaysWithoutReexecution` | 整批执行一次；重放重发缓存结果、不重复执行变更类工具 |
| `TestBatchFailsClosed` | 空批次、未知动作、带未决工具的终态 idle 均 fail-closed |
| `TestStreamResumesWithLastEventIDAndDeduplicates` | 断线用 `Last-Event-ID` 续传，重放事件被去重，事件恰好各处理一次 |

预期输出以 `ok  example.com/qoder-cloud-runtime-demo` 结尾。

## 清理资源

Demo 全程在进程内运行，不创建任何外部资源，无需清理。删除 Go 构建缓存可执行 `go clean -testcache`。

## 成本与安全

- 本 Demo 不进行任何真实网络调用，也不消耗账号额度：`httptest` 服务端在本地进程内运行。
- 代码中不含任何真实凭证。示例里的 `placeholder-token` 仅用于占位。
- 分派器是 fail-closed 的白名单：接入真实后端时，请把云端 PAT 与业务任务令牌分别持有，任务令牌绝不写入云请求、Prompt、工具输入/结果或日志。
- 进程内的“恰好一次”只在单进程生命周期内成立；跨进程崩溃的调用 ID 幂等属于接入真实系统时需自行加固的部分。
