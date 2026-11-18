from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", frozen=True)

    qoder_pat: str = Field(alias="QODER_PAT")
    qoder_agent_id: str = Field(alias="QODER_AGENT_ID")
    qoder_environment_id: str = Field(alias="QODER_ENVIRONMENT_ID")
    qoder_managed_base_url: str = Field(
        default="https://api.qoder.com/api/v1/cloud",
        alias="QODER_MANAGED_BASE_URL",
    )
    gateway_api_key: str | None = Field(default=None, alias="GATEWAY_API_KEY")
@lru_cache
def get_settings() -> Settings:
    return Settings()  # pyright: ignore[reportCallIssue]  # values are loaded from environment aliases
