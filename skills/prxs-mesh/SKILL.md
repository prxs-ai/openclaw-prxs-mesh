---
name: prxs-mesh
description: Discover and run PRXS mesh services from OpenClaw (with approvals via exec).
version: 0.1.0
user-invocable: false
---

# PRXS Mesh

You have access to PRXS mesh discovery tools and per-service tools synced from a PRXS registry.

## CRITICAL: How to Call Services

**NEVER generate curl commands or HTTP requests to call PRXS services!**

PRXS services run on a P2P mesh network, NOT HTTP endpoints. The ONLY way to call them:

1. **Call the per-service tool** (e.g., `prxs_TavilySearch_v1(query="...")`)
2. **Get the `exec.command`** from the response
3. **Use OpenClaw `exec` tool** with that exact command

## Workflow

### Step 1: Call the per-service tool

```
prxs_TavilySearch_v1(query="bitcoin price")
```

This returns JSON with `exec.command` containing the PRXS node binary command.

### Step 2: Execute with approval

Use OpenClaw `exec` tool with the EXACT command from `exec.command`. Example command:
```
/path/to/node -mode client -bootstrap "..." -query "TavilySearch-v1" -args '["bitcoin price"]' -dev=false
```

### Step 3: Parse output (optional)

Use `prxs_parse_node_output` to extract the result.

## Available Per-Service Tools

Tools like `prxs_TavilySearch_v1`, `prxs_PriceOracle_v1`, etc. are auto-synced from the registry.

## Discovery Tools (optional)

- `prxs_list_services` - list all services
- `prxs_search_services` - search by name
- `prxs_semantic_search` - natural language search
- `prxs_get_service` - get service details

## FORBIDDEN Actions

- Do NOT generate curl commands
- Do NOT make HTTP requests to any IP/port
- Do NOT assume services have REST endpoints
- Do NOT invent commands - ONLY use `exec.command` from PRXS tools

## Notes

- Execution requires user approval via OpenClaw `exec`
- Services run via P2P mesh, not HTTP
- The `exec.command` contains the full PRXS node binary invocation
