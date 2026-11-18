from collections.abc import AsyncIterator

from fastapi.testclient import TestClient

from litellm_qoder_cloud_agents.app import create_app
from litellm_qoder_cloud_agents.config import Settings
from litellm_qoder_cloud_agents.qoder import RunResult


class FakeRunner:
    async def run(self, prompt: str, session_id: str | None = None) -> RunResult:
        assert prompt
        return RunResult(session_id=session_id or "sess_test", text="done")

    async def stream(self, prompt: str, session_id: str | None = None) -> AsyncIterator[tuple[str, str]]:
        assert prompt
        yield session_id or "sess_test", "do"
        yield session_id or "sess_test", "ne"


def settings(api_key: str | None = "test-gateway-key") -> Settings:
    return Settings(
        QODER_PAT="test-qoder-pat",
        QODER_AGENT_ID="agent_test",
        QODER_ENVIRONMENT_ID="env_test",
        GATEWAY_API_KEY=api_key,
    )


def test_chat_completion_is_openai_compatible() -> None:
    client = TestClient(create_app(settings(), FakeRunner()))
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": "Bearer test-gateway-key"},
        json={"model": "qoder-agent", "messages": [{"role": "user", "content": "fix the tests"}]},
    )

    assert response.status_code == 200
    assert response.json()["choices"][0]["message"] == {"role": "assistant", "content": "done"}


def test_interaction_continues_existing_qoder_session() -> None:
    client = TestClient(create_app(settings(), FakeRunner()))
    response = client.post(
        "/v1/interactions",
        headers={"Authorization": "Bearer test-gateway-key"},
        json={"agent": "qca/agent_test/env_test", "input": "continue", "previous_interaction_id": "qca1.sess_existing"},
    )

    assert response.status_code == 200
    assert response.json()["id"] == "qca1.sess_existing"
    assert response.json()["outputs"] == [{"type": "text", "text": "done"}]


def test_gateway_rejects_invalid_key() -> None:
    client = TestClient(create_app(settings(), FakeRunner()))
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": "Bearer wrong"},
        json={"model": "qoder-agent", "messages": [{"role": "user", "content": "hello"}]},
    )

    assert response.status_code == 401


def test_chat_completion_stream_uses_openai_sse_shape() -> None:
    client = TestClient(create_app(settings(), FakeRunner()))
    response = client.post(
        "/v1/chat/completions",
        headers={"Authorization": "Bearer test-gateway-key"},
        json={"model": "qoder-agent", "messages": [{"role": "user", "content": "hello"}], "stream": True},
    )

    assert response.status_code == 200
    assert '"object":"chat.completion.chunk"' in response.text
    assert '"content":"do"' in response.text
    assert response.text.endswith("data: [DONE]\n\n")
