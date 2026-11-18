from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, MagicMock

from qca import AsyncManaged

from litellm_qoder_cloud_agents.config import Settings
from litellm_qoder_cloud_agents.qoder import ManagedQoderRunner


class FakeEventStream:
    async def __aenter__(self) -> "FakeEventStream":
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    def __aiter__(self) -> AsyncIterator[SimpleNamespace]:
        async def events() -> AsyncIterator[SimpleNamespace]:
            yield SimpleNamespace(type="agent.message.delta", delta=SimpleNamespace(text="done"), content=None)
            yield SimpleNamespace(type="session.status_idle", delta=None, content=None)

        return events()


async def test_new_session_identifies_litellm_as_resource_source() -> None:
    client: MagicMock = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=None)
    client.sessions.create = AsyncMock(return_value=SimpleNamespace(id="sess_test"))
    client.sessions.events.send = AsyncMock()
    client.sessions.events.stream = AsyncMock(return_value=FakeEventStream())
    config = Settings(
        QODER_PAT="test-qoder-pat",
        QODER_AGENT_ID="agent_test",
        QODER_ENVIRONMENT_ID="env_test",
    )
    runner = ManagedQoderRunner(config, client_factory=lambda: cast(AsyncManaged, client))

    chunks = [chunk async for chunk in runner.stream("finish the task")]

    assert chunks == [("sess_test", "done")]
    client.sessions.create.assert_awaited_once_with(
        agent="agent_test",
        environment_id="env_test",
        metadata={"source": "litellm"},
    )
