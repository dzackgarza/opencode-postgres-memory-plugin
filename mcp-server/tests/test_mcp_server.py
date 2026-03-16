import pytest
from opencode_memory_mcp.mcp_server import mcp

@pytest.mark.asyncio
async def test_mcp_tools_and_descriptions():
    """Verify tools are registered and have agent-oriented descriptions."""
    tools = await mcp.list_tools()
    tool_map = {tool.name: tool for tool in tools}

    expected_tools = {"remember", "list_memories", "forget"}
    assert set(tool_map.keys()) == expected_tools

    for tool in tools:
        assert tool.description.strip().startswith("Use when"), f"Tool {tool.name} description should start with 'Use when'"
