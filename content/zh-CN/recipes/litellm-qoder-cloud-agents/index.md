---
schema_version: 1
slug: litellm-qoder-cloud-agents
title: 通过 LiteLLM 接入 Qoder Cloud Agents
summary: 使用一个轻量兼容网关，把现有 LiteLLM、OpenAI SDK 和 Agent API 客户端接入 Qoder Cloud Agents，并按任务需求选择会话延续或 Chat Completions 兼容模式。
type: recipe
category: enterprise-integration
tags:
  - agent
  - api
  - sdk
  - session
  - authentication
author:
  name: 安辰
  github: hellomypastor
locale: zh-CN
---

## 目标与适用场景

Qoder Cloud Agents 使用 Agent、Environment、Session 和事件流组织长时间运行的代码任务。很多应用则已经围绕 LiteLLM、OpenAI Python SDK 或 Chat Completions API 建立了模型调用层。本文使用一个轻量兼容网关连接两套接口，让现有客户端无需自行实现 Session 创建、消息发送和 SSE 事件消费。

网关提供两种接入方式：

| 场景 | 推荐接口 | 原因 |
| --- | --- | --- |
| 已有 LiteLLM 或 OpenAI SDK 客户端 | Model API | 保留熟悉的 Chat Completions 调用方式 |
| 一次性请求并需要标准模型响应 | Model API | 返回 OpenAI-compatible 响应 |
| 长时间代码任务 | Agent API | 保留 Agent 和 Session 语义 |
| 继续上一次任务 | Agent API | 使用 `previous_interaction_id` 继续原 Session |
| 实时展示执行结果 | Agent API | 可直接消费 SSE 事件流 |

当前 Model API 每次请求都会创建新的 Qoder Session。需要多轮复用同一工作目录和任务上下文时，应使用 Agent API。

## 操作步骤

先在 Qoder Cloud Agents 中准备一个 Agent、一个 Environment 和用于本地验证的 PAT。然后进入 Demo 目录，复制示例配置：

```bash
cd demos/litellm-qoder-cloud-agents
cp .env.example .env
```

在 `.env` 中填写 `QODER_PAT`、`QODER_AGENT_ID`、`QODER_ENVIRONMENT_ID`，并为 `GATEWAY_API_KEY` 和 `LITELLM_MASTER_KEY` 分别生成高熵随机值。不要把 `.env` 提交到版本库。

使用 Docker Compose 启动 Qoder 兼容网关和 LiteLLM：

```bash
docker compose up --build
```

Agent API 默认监听网关服务的 `4001` 端口，路径为 `/v1/interactions`。第一次请求创建 Qoder Session，响应中的 `id` 是不透明的续接标识；把它原样作为下一次请求的 `previous_interaction_id`，即可继续原 Session。请求体增加 `"stream": true` 后，响应改为 SSE 事件流。

LiteLLM 默认监听模型服务的 `4000` 端口，路径为 `/v1/chat/completions`。Demo 中的 `config/litellm.yaml` 注册了 `qoder-cloud-agent` 模型，并通过 OpenAI-compatible provider 把请求转发到网关。现有 OpenAI SDK 客户端只需替换 `base_url`、API Key 和模型名。

## 验证结果

先检查网关健康状态：

```bash
curl "$QODER_GATEWAY_URL/health/liveliness"
```

预期返回 `{"status":"ok"}`。随后分别调用 Agent API 和 LiteLLM Model API：前者应返回以 `qca1.` 开头的 `id` 和文本输出，后者应返回 `object: "chat.completion"` 以及非空的 `choices[0].message.content`。

Demo 还包含不访问外部网络的单元测试，用模拟 Runner 验证 API 鉴权、Session 延续、流式响应和新 Session 的来源标记。完整的配置、调用命令、清理步骤与生产安全边界见 Demo README。

[查看 Demo 源码](https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/litellm-qoder-cloud-agents)

## 常见问题与生产边界

如果 LiteLLM 找不到 `qoder-cloud-agent`，确认容器已加载 Demo 中的 `config/litellm.yaml`，并且 `QODER_GATEWAY_BASE_URL` 在容器网络内指向网关服务。若请求返回 401，分别检查调用网关时使用的 `GATEWAY_API_KEY` 和调用 LiteLLM 时使用的 `LITELLM_MASTER_KEY`，两者用途不同。

这个示例是单 Agent、单 Environment 的兼容层，不是生产就绪的多租户网关。生产部署至少需要 TLS、网络访问控制、限流、审计、集中式密钥管理和凭据轮换。真实请求会创建或继续 Qoder Session 并消耗额度；Agent 也可能读取或修改 Environment 中可访问的数据和代码，因此应使用隔离环境并审查产出。
