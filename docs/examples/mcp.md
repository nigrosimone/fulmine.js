---
description: "A Model Context Protocol server with the official SDK on the Streamable HTTP transport, a session per client, served by fulmine.js."
---

# An MCP server on Express

The official MCP SDK works unchanged. The page shows the shape of the Streamable HTTP transport and the one thing uWS does differently with a stream that stays open.

From a clone of the repository:

```sh
cd examples && npm install
node mcp.js
```

<<< @/../examples/mcp.js

See also: [Compatibility](/compatibility).
