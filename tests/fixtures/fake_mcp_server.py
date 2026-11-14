"""Minimal stdio / streamable-HTTP MCP server for tests (no network beyond loopback)."""
import os
import sys
from mcp.server.mcpserver import MCPServer

mcp = MCPServer("fake")


@mcp.tool()
def echo(text: str) -> str:
    """Echo text back, prefixed with the FAKE_MCP_TAG env value."""
    return f"{os.environ.get('FAKE_MCP_TAG', '')}:{text}"


@mcp.tool()
def secret_tag() -> str:
    """Return whether the secret env arrived."""
    return "yes" if os.environ.get("FAKE_MCP_SECRET") == "s3cret" else "no"


if __name__ == "__main__":
    if "--http" in sys.argv:
        mcp.run(transport="streamable-http", host="127.0.0.1", port=int(os.environ["FAKE_MCP_PORT"]))
    else:
        mcp.run(transport="stdio")
