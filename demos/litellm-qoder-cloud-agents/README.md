# LiteLLM 接入 Qoder Cloud Agents Demo

这个 Demo 提供一个可独立部署的兼容网关，把 LiteLLM、OpenAI Python SDK 或直接的 HTTP 请求转换为 Qoder Cloud Agents Session API 调用。它支持两条路径：

- Agent API：调用 `POST /v1/interactions`，并通过 `previous_interaction_id` 继续同一个 Qoder Session。
- Model API：调用 LiteLLM 的 `POST /v1/chat/completions`，由 LiteLLM 通过 OpenAI-compatible provider 路由到网关。

## 对应文章

- 标题：通过 LiteLLM 接入 Qoder Cloud Agents
- Slug：`litellm-qoder-cloud-agents`

## 前置条件

- Docker Engine 24 或更高版本，以及 Docker Compose v2。
- 一个可用的 Qoder Cloud Agents Agent 和 Environment。
- 本地验证使用 Qoder 个人访问令牌（PAT）；生产环境应使用适合服务端的短期凭证或 Service Account Token 流程。
- 如需直接运行或测试 Python 项目，安装 Python 3.10 或更高版本。

## 安装与配置

在本目录复制示例配置：

```bash
cp .env.example .env
```

编辑 `.env`，把所有占位符替换为自己的值：

```text
QODER_PAT=replace-me
QODER_AGENT_ID=agent_replace_me
QODER_ENVIRONMENT_ID=env_replace_me
GATEWAY_API_KEY=replace-me
LITELLM_MASTER_KEY=replace-me
QODER_GATEWAY_BASE_URL=http://qoder-cloud-agents:4001/v1
```

`GATEWAY_API_KEY` 和 `LITELLM_MASTER_KEY` 应使用不同的高熵随机值。不要提交 `.env`；它已被 `.gitignore` 排除。

## 运行

启动网关和 LiteLLM：

```bash
docker compose up --build
```

另开一个终端，根据 Compose 发布的端口设置下面调用所用的基地址：

```bash
QODER_GATEWAY_URL="http://$(docker compose port qoder-cloud-agents 4001)"
LITELLM_URL="http://$(docker compose port litellm 4000)"
export QODER_GATEWAY_URL LITELLM_URL
```

直接调用 Agent API：

```bash
curl "$QODER_GATEWAY_URL/v1/interactions" \
  -H "Authorization: Bearer $GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "qca/agent_replace_me/env_replace_me",
    "input": "检查代码并给出修改建议"
  }'
```

保存返回的 `id`，可在下一次请求中作为 `previous_interaction_id` 继续同一个 Session。要实时接收结果，在请求体中加入 `"stream": true`。

通过 LiteLLM 调用 Model API：

```bash
curl "$LITELLM_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qoder-cloud-agent",
    "messages": [{"role": "user", "content": "检查代码并给出修改建议"}]
  }'
```

Model API 当前每次请求都会创建新的 Qoder Session。需要连续使用同一个工作目录和任务上下文时，请使用 Agent API。

## 验证结果

先验证服务存活：

```bash
curl "$QODER_GATEWAY_URL/health/liveliness"
```

预期返回 `{"status":"ok"}`。Agent API 成功响应的 `id` 以 `qca1.` 开头；Model API 成功响应包含 `object: "chat.completion"` 和非空的 `choices[0].message.content`。

单元测试使用模拟 Runner，不调用 Qoder，也不消耗额度：

```bash
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/ruff check .
.venv/bin/pytest
```

## 清理资源

停止并删除本地容器和网络：

```bash
docker compose down --remove-orphans
```

删除本地 `.env` 和虚拟环境；不再使用的 PAT 与 API Key 应在对应平台吊销或轮换。通过本 Demo 创建的 Qoder Session 可在 Qoder 控制台中归档或删除。

## 成本与安全

- 真实的 Agent API 和 Model API 请求会创建或继续 Qoder Session，并消耗 Qoder 额度；单元测试不会。
- 网关能代表调用者向绑定的 Agent 和 Environment 发起任务。只授予必要权限，并使用独立、可轮换的凭据。
- `GATEWAY_API_KEY` 未设置时，网关的 `/v1` 接口不会执行应用层鉴权。不要在公网或共享网络中以这种方式运行。
- 示例将端口绑定到本机所有接口。生产部署应增加 TLS、网络访问控制、请求限流、审计与集中式密钥管理。
- Agent 可能读取或修改 Environment 中可访问的数据和代码。使用隔离环境，并在合并或发布前审查结果。
- 此 Demo 是兼容层示例，不是生产就绪的多租户网关。
