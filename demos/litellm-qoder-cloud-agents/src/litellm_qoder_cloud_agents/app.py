import json
import time
from collections.abc import AsyncIterator
from typing import Final

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from qca import APIStatusError

from litellm_qoder_cloud_agents.config import Settings, get_settings
from litellm_qoder_cloud_agents.models import (
    ChatChoice,
    ChatChoiceMessage,
    ChatCompletionRequest,
    ChatCompletionResponse,
    InteractionRequest,
    InteractionResponse,
    TextContent,
    chat_prompt,
    interaction_text,
)
from litellm_qoder_cloud_agents.qoder import (
    ManagedQoderRunner,
    QoderRunner,
    decode_interaction_id,
    encode_interaction_id,
)


def _sse(payload: object) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


def create_app(settings: Settings | None = None, runner: QoderRunner | None = None) -> FastAPI:
    resolved_settings: Final = settings or get_settings()
    resolved_runner: Final = runner or ManagedQoderRunner(resolved_settings)

    async def authorize(authorization: str | None = Header(default=None)) -> None:
        if resolved_settings.gateway_api_key is None:
            return
        if authorization != f"Bearer {resolved_settings.gateway_api_key}":
            raise HTTPException(status_code=401, detail="Invalid gateway API key")

    app = FastAPI(title="LiteLLM Qoder Cloud Agents Gateway", version="0.1.0")

    @app.get("/health/liveliness")
    async def liveliness() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/v1/interactions", dependencies=[Depends(authorize)], response_model=None)
    async def interactions(request: InteractionRequest) -> InteractionResponse | StreamingResponse:
        prompt: Final = interaction_text(request.input)
        try:
            session_id: Final = decode_interaction_id(request.previous_interaction_id)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        if request.stream:

            async def stream() -> AsyncIterator[str]:
                interaction_id: str | None = None
                async for current_session_id, text in resolved_runner.stream(prompt, session_id):
                    interaction_id = encode_interaction_id(current_session_id)
                    yield _sse(
                        {
                            "event_type": "content.delta",
                            "interaction_id": interaction_id,
                            "delta": {"type": "text", "text": text},
                        }
                    )
                yield _sse(
                    {
                        "event_type": "interaction.status_update",
                        "interaction_id": interaction_id,
                        "status": "completed",
                    }
                )
                yield "data: [DONE]\n\n"

            return StreamingResponse(stream(), media_type="text/event-stream")
        result: Final = await resolved_runner.run(prompt, session_id)
        return InteractionResponse(
            id=encode_interaction_id(result.session_id),
            agent=request.agent or resolved_settings.qoder_agent_id,
            outputs=(TextContent(text=result.text),),
        )

    @app.post("/v1/chat/completions", dependencies=[Depends(authorize)], response_model=None)
    async def chat_completions(request: ChatCompletionRequest) -> ChatCompletionResponse | StreamingResponse:
        prompt: Final = chat_prompt(request.messages)
        if request.stream:

            async def stream() -> AsyncIterator[str]:
                async for session_id, text in resolved_runner.stream(prompt):
                    yield _sse(
                        {
                            "id": encode_interaction_id(session_id),
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": request.model,
                            "choices": [{"index": 0, "delta": {"content": text}, "finish_reason": None}],
                        }
                    )
                yield _sse(
                    {
                        "id": "",
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": request.model,
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    }
                )
                yield "data: [DONE]\n\n"

            return StreamingResponse(stream(), media_type="text/event-stream")
        result: Final = await resolved_runner.run(prompt)
        return ChatCompletionResponse(
            id=encode_interaction_id(result.session_id),
            created=int(time.time()),
            model=request.model,
            choices=(ChatChoice(message=ChatChoiceMessage(content=result.text)),),
        )

    @app.exception_handler(APIStatusError)
    async def qoder_error_handler(_request: object, error: APIStatusError):
        return fastapi_error(error.status_code, str(error), "qoder_api_error")

    @app.exception_handler(RuntimeError)
    async def runtime_error_handler(_request: object, error: RuntimeError):
        return fastapi_error(502, str(error), "qoder_runtime_error")

    return app


def fastapi_error(status_code: int, message: str, error_type: str):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=status_code, content={"error": {"message": message, "type": error_type}})
