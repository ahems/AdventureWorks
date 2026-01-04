#!/usr/bin/env python3
"""
Test script for AdventureWorks Customer Service AI Agent

This script demonstrates how to interact with the AI Agent that was created
during deployment. The agent has access to the AdventureWorks MCP Server tools.

Usage:
    python3 test_agent.py
    
Or with a specific query:
    python3 test_agent.py "What mountain bikes do you have?"
"""

import asyncio
import sys
import json
from pathlib import Path


async def test_agent(query: str = None):
    """Test the AdventureWorks AI Agent with a query"""
    
    try:
        from agent_framework import ChatAgent, MCPStreamableHTTPTool
        from agent_framework_azure_ai import AzureAIAgentClient
        from azure.identity.aio import DefaultAzureCredential
    except ImportError as e:
        print(f"❌ Required package not installed: {e}")
        print("Install with: pip install agent-framework-azure-ai --pre")
        return 1
    
    # Load agent configuration
    config_path = Path("AI_AGENT_CONFIG.json")
    if not config_path.exists():
        print("❌ Agent configuration not found. Run 'azd provision' first to create the agent.")
        return 1
    
    with open(config_path) as f:
        config = json.load(f)
    
    print(f"🤖 Loading {config['agent_name']}...")
    print(f"   Model: {config['model']}")
    print(f"   MCP Server: {config['mcp_server']}")
    print()
    
    # Create MCP tool
    mcp_tool = MCPStreamableHTTPTool(
        name="AdventureWorks MCP",
        description="Provides customer service tools for AdventureWorks",
        url=config['mcp_server'],
    )
    
    # Create agent
    async with DefaultAzureCredential() as credential:
        chat_client = AzureAIAgentClient(
            project_endpoint=config['endpoint'],
            model_deployment_name=config['model'],
            async_credential=credential,
            agent_name=config['agent_name'],
        )
        
        async with ChatAgent(
            chat_client=chat_client,
            instructions='''You are a helpful customer service assistant for AdventureWorks.
            
Use the available tools to help customers with:
- Order tracking (use Customer ID)
- Product searches
- Product recommendations
- Order details

Always be friendly and helpful.''',
            tools=[mcp_tool],
        ) as agent:
            
            # Use provided query or default
            if not query:
                query = "What tools do you have access to help customers?"
            
            print(f"👤 User: {query}\n")
            print("🤖 Agent: ", end="", flush=True)
            
            # Stream the response
            async for chunk in agent.run_stream(query):
                if chunk.text:
                    print(chunk.text, end="", flush=True)
            
            print("\n")
            return 0


def main():
    # Get query from command line if provided
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else None
    
    # Run the async test
    exit_code = asyncio.run(test_agent(query))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
