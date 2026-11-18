from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Protocol

from qca import AsyncManaged

from litellm_qoder_cloud_agents.config import Settings


@dataclass(frozen=True, slots=True)
class RunResult:
    session_id: str
    text: str


class QoderRunner(Protocol):
    async def run(self, prompt: str, session_id: str | None = None) -> RunResult: ...

    def stream(self, prompt: str, session_id: str | None = None) -> AsyncIterator[tuple[str, str]]: ...


class ManagedQoderRunner:
    def __init__(self, settings: Settings, client_factory: Callable[[], AsyncManaged] | None = None) -> None:
        self._settings = settings
        self._client_factory = client_factory or self._create_client

    def _create_client(self) -> AsyncManaged:
        return AsyncManaged(
            pat=self._settings.qoder_pat,
            base_url=self._settings.qoder_managed_base_url,
        )

    async def _session_id(self, client: AsyncManaged, session_id: str | None) -> str:
        if session_id is not None:
            return session_id
        session = await client.sessions.create(
            agent=self._settings.qoder_agent_id,
            environment_id=self._settings.qoder_environment_id,
            metadata={"source": "litellm"},
        )
        if session.id is None:
            raise RuntimeError("Qoder did not return a session ID")
        return session.id

    async def stream(self, prompt: str, session_id: str | None = None) -> AsyncIterator[tuple[str, str]]:
        async with self._client_factory() as client:
            resolved_session_id = await self._session_id(client, session_id)
            await client.sessions.events.send(
                resolved_session_id,
                events=[{"type": "user.message", "content": [{"type": "text", "text": prompt}]}],
            )
            async with await client.sessions.events.stream(
                resolved_session_id,
                event_deltas=["agent.message"],
            ) as events:
                async for event in events:
                    if event.type == "agent.message.delta" and event.delta is not None and event.delta.text:
                        yield resolved_session_id, event.delta.text
                    if event.type == "agent.message" and event.content:
                        for content in event.content:
                            if content.type == "text" and content.text:
                                yield resolved_session_id, content.text
                    if event.type == "session.status_idle":
                        return
                    if event.type in {"session.status_failed", "session.status_terminated", "session.error"}:
                        raise RuntimeError(f"Qoder session ended with {event.type}")
        raise RuntimeError("Qoder event stream ended before the session became idle")

    async def run(self, prompt: str, session_id: str | None = None) -> RunResult:
        chunks: list[str] = []
        resolved_session_id: str | None = None
        async for current_session_id, text in self.stream(prompt, session_id):
            resolved_session_id = current_session_id
            chunks.append(text)
        if resolved_session_id is None:
            raise RuntimeError("Qoder returned no output")
        return RunResult(session_id=resolved_session_id, text="".join(chunks))


def encode_interaction_id(session_id: str) -> str:
    return f"qca1.{session_id}"


def decode_interaction_id(interaction_id: str | None) -> str | None:
    if interaction_id is None:
        return None
    prefix, separator, session_id = interaction_id.partition(".")
    if prefix != "qca1" or not separator or not session_id.startswith("sess_"):
        raise ValueError("previous_interaction_id is invalid")
    return session_id
