from typing import Literal

from pydantic import BaseModel, ConfigDict


class FrozenModel(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ChatMessage(FrozenModel):
    role: Literal["system", "user", "assistant"]
    content: str


class ChatCompletionRequest(FrozenModel):
    model: str
    messages: tuple[ChatMessage, ...]
    stream: bool = False


class InteractionInput(FrozenModel):
    role: Literal["user"] = "user"
    content: str


class InteractionRequest(FrozenModel):
    agent: str | None = None
    input: str | InteractionInput
    stream: bool = False
    previous_interaction_id: str | None = None


class TextContent(FrozenModel):
    type: Literal["text"] = "text"
    text: str


class InteractionResponse(FrozenModel):
    id: str
    object: Literal["interaction"] = "interaction"
    status: Literal["completed"] = "completed"
    agent: str
    outputs: tuple[TextContent, ...]


class ChatChoiceMessage(FrozenModel):
    role: Literal["assistant"] = "assistant"
    content: str


class ChatChoice(FrozenModel):
    index: int = 0
    message: ChatChoiceMessage
    finish_reason: Literal["stop"] = "stop"


class ChatCompletionResponse(FrozenModel):
    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: tuple[ChatChoice, ...]


class ErrorBody(FrozenModel):
    message: str
    type: str


class ErrorResponse(FrozenModel):
    error: ErrorBody


def interaction_text(value: str | InteractionInput) -> str:
    return value if isinstance(value, str) else value.content


def chat_prompt(messages: tuple[ChatMessage, ...]) -> str:
    return "\n\n".join(f"{message.role}: {message.content}" for message in messages)
