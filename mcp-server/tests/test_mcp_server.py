import pytest
from opencode_memory_mcp.mcp_server import mcp

@pytest.mark.asyncio
async def test_mcp_tools():
    """Verify that all tools are registered in FastMCP."""
    tools = await mcp.list_tools()
    tool_names = [tool.name for tool in tools]
    assert "remember" in tool_names
    assert "list_memories" in tool_names
    assert "forget" in tool_names

@pytest.mark.asyncio
async def test_mcp_tool_descriptions():
    """Verify that tools have 'Use when...' in their descriptions."""
    tools = await mcp.list_tools()
    for tool in tools:
        assert tool.description.strip().startswith("Use when"), f"Tool {tool.name} description should start with 'Use when'"
