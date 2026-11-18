from ipaddress import IPv4Address

import uvicorn


def run() -> None:
    uvicorn.run("litellm_qoder_cloud_agents.app:create_app", factory=True, host=str(IPv4Address(0)), port=4001)
