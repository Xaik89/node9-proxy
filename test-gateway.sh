#!/bin/bash
# Sends a bash tool call with sudo — triggers the review-sudo smart rule
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bash","arguments":{"command":"sudo ls /root"}}}' | node dist/cli.js mcp-gateway --upstream 'npx -y @modelcontextprotocol/server-filesystem /home/nadav/node9ai'
