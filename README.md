# PRXS Mesh OpenClaw Plugin

This plugin connects OpenClaw to a **remote PRXS registry** and exposes PRXS services as **OpenClaw tools**. It is designed around a simple security rule:

- **Discovery is read-only** (HTTP to the registry).
- **Execution is always gated by a human approval** (via OpenClaw `exec` approvals).

## What you get

- Read-only tools to browse/search the registry.
- A `prxs_sync_tools` tool to "deploy" per-service tools from the registry.
- Per-service tools (e.g. `prxs_math`) that return an `exec` object (`{ command, host, security, ask }`) ready for OpenClaw `exec`.
- You run it via OpenClaw's built-in `exec` tool, so the user approves every execution.
- Optional ERC-8004 identity verification (`prxs_erc8004_*`) when `service.card.agent_id` is present.

## Architecture (why approvals work)

- PRXS registry is used for **discovery only** (REST `/api/v1/...`).
- Service execution happens via the local PRXS Go binary: `bin/node -mode client ...`.
- The plugin returns an `exec` payload instead of executing anything internally, so OpenClaw’s **Exec approvals** can gate every run.

## Requirements

- OpenClaw installed (requires Node `>=22`).
- A reachable PRXS Registry URL (your server), e.g. `https://registry.example.com:8080`.
- The PRXS binary `./bin/node` (built from `cmd/node`) must exist on the machine that will run `exec`:
  - By default this is the **Gateway host** (`exec.host=gateway`).
  - If you set `execHost=node`, the binary must exist on that **node host** and approvals must be configured there.

## Install OpenClaw (quick)

Recommended install:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
openclaw gateway status
openclaw dashboard
```

Notes:
- The Gateway refuses to start unless `gateway.mode=local` is set in `~/.openclaw/openclaw.json` (the `onboard --install-daemon` flow configures this).
- If you prefer a foreground Gateway for dev, OpenClaw supports `openclaw gateway run` (and `--allow-unconfigured` for a temporary dev run).

## Install the plugin

This installs the plugin code into the OpenClaw Gateway runtime (plugins run **in-process** inside the Gateway).

From this repo root:

```bash
openclaw plugins install -l ./extensions/prxs-mesh
openclaw plugins list
openclaw gateway restart
```

If you use a **remote Gateway**, install the plugin on the remote Gateway machine (not on your laptop), then restart that Gateway.

## Configure the plugin

Edit `~/.openclaw/openclaw.json` (Gateway config).

In your OpenClaw config, set:

- `plugins.entries.prxs-mesh.config.registryUrl`
- `plugins.entries.prxs-mesh.config.prxsNodeBinary` (must point to the PRXS Go binary, not Node.js)
- `plugins.entries.prxs-mesh.config.devMode=false` (recommended for remote registries)

Example `~/.openclaw/openclaw.json` fragment:

```json
{
  "plugins": {
    "entries": {
      "prxs-mesh": {
        "enabled": true,
        "config": {
          "registryUrl": "https://registry.example.com:8080",
          "prxsNodeBinary": "/abs/path/to/prxs-node/bin/node",
          "devMode": false,
          "autoSyncTools": true
        }
      }
    }
  }
}
```

Apply changes:

```bash
openclaw gateway restart
```

### Windows notes

- Build a Windows binary: `go build -o bin/node.exe ./cmd/node`
- Set `prxsNodeBinary` to the full path of `node.exe` (e.g. `C:\\prxs-node\\bin\\node.exe` or `C:/prxs-node/bin/node.exe`)
- Allowlist the same `node.exe` path for Exec approvals

## Exec approvals (required for “user must approve”)

The recommended setup is:
- `exec.host=gateway`
- `security=allowlist`
- `ask=always`

Allowlist your PRXS binary on the Gateway host:

```bash
openclaw approvals allowlist add --gateway "/abs/path/to/prxs-node/bin/node"
```

You can inspect current approvals:

```bash
openclaw approvals get --gateway
```

Important:
- Exec approvals apply to `host=gateway` / `host=node` (not `sandbox`).
- This plugin returns `exec.host=gateway` by default for prepared commands.
- If you set `execHost=node`, configure a target node either via this plugin (`execNode`) or via OpenClaw `tools.exec.node`.

## Optional tools (must be allowlisted)

Some tools are registered with `optional: true` (opt-in):
- `prxs_sync_tools`
- `prxs_prepare_call`
- `prxs_prepare_spawn_provider`

Enable them by allowlisting either the specific tool names **or** the plugin id `prxs-mesh`.

Recommended (additive allowlist):

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": {
          "alsoAllow": ["prxs_prepare_call", "prxs_sync_tools"]
        }
      }
    ]
  }
}
```

Or enable all tools from this plugin (including per-service tools created by `prxs_sync_tools`):

```json
{
  "tools": {
    "alsoAllow": ["prxs-mesh"]
  }
}
```

Alternative (restrictive allowlist): use `tools.allow` / `agents.list[].tools.allow` if you intentionally want an allow-only mode.

When invoking OpenClaw `exec`, keep `host=gateway` (or `node`). The `exec` default is `host=sandbox`, and if sandboxing is disabled, `host=sandbox` runs without approvals.

Optional: forward approvals to chat and resolve them with `/approve <id> allow-once|allow-always|deny`.

Optional (ERC-8004):

- `plugins.entries.prxs-mesh.config.erc8004RpcUrl`
- `plugins.entries.prxs-mesh.config.erc8004IdentityRegistry`
- `plugins.entries.prxs-mesh.config.erc8004VerifyOnPrepare`

Then run `prxs_sync_tools` once (or keep `autoSyncTools=true`).

## Usage flow (end-to-end)

1) Discover:
- `prxs_semantic_search` (natural language), or
- `prxs_list_services` / `prxs_search_services` / `prxs_get_service`

2) Deploy tools from registry (optional):
- `prxs_sync_tools` → registers `prxs_<service>` tools locally inside OpenClaw

3) Prepare an execution:
- Call `prxs_prepare_call(serviceName, args)` or `prxs_<service>(...)`
- You’ll get:
  - `exec` (pass into OpenClaw `exec` as-is)
  - `execPlan.argv` (exact argv)
  - provider list + selected provider + bootstrap

4) Execute (with approval):
- Call OpenClaw `exec` with `command: <prepared.exec.command>`
- Approve in UI (or `/approve`)

5) Parse output (optional):
- `prxs_parse_node_output(stdout)` extracts the `--- RESULT ---` block

For a full end-to-end walkthrough (including running a registry/provider), see `extensions/prxs-mesh/FLOW.md`.

## Testing (step-by-step from scratch)

This section is intentionally verbose so you can follow it on a clean machine.

### 0) Prepare the PRXS node binary (on the OpenClaw exec host)

You only need this for *execution*. Discovery-only tools (list/search) will work without it.

On the machine that runs your OpenClaw Gateway:

```bash
git clone <your-prxs-node-repo-url>
cd prxs-node
go build -o bin/node ./cmd/node
```

### 1) Start the PRXS Registry (your server)

Run on the registry host:

```bash
go build -o bin/registry ./cmd/registry
go build -o bin/node ./cmd/node

# If you’re behind NAT/Docker, strongly prefer setting an explicit bootstrap.
# Best: full multiaddr
export PRXS_REGISTRY_BOOTSTRAP="/dns4/registry.example.com/udp/4001/quic-v1/p2p/12D3KooW..."

# Or: build DNS bootstraps automatically
# export PRXS_REGISTRY_ADVERTISE_DNS="registry.example.com"

./bin/registry -port 4001 -api-port 8080 -dev=false
```

Quick checks:

```bash
curl "http://127.0.0.1:8080/api/v1/registry/info"
curl "http://127.0.0.1:8080/api/v1/services_full"
```

### 2) Start a provider (any machine)

```bash
./bin/node -mode provider \
  -port 6010 \
  -bootstrap "<BOOTSTRAP_MULTIADDR_FROM_REGISTRY_INFO>" \
  -agent sample_agents/calc.py \
  -stake-amount 12 \
  -stake-chain mock-l2 \
  -stake-web-port 8090
```

### 3) OpenClaw side: install + check Gateway

On the machine that runs your OpenClaw Gateway:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw onboard --install-daemon
openclaw gateway status
openclaw dashboard
```

### 4) Install + enable the PRXS plugin

```bash
openclaw plugins install -l /abs/path/to/prxs-node/extensions/prxs-mesh
openclaw plugins list
openclaw gateway restart
```

### 5) Configure plugin in `~/.openclaw/openclaw.json`

Set:
- `registryUrl` to your remote Registry HTTP URL
- `prxsNodeBinary` to the **local** `bin/node` path on the Gateway host

Restart:

```bash
openclaw gateway restart
```

### 6) Configure exec approvals (human must approve)

```bash
openclaw approvals allowlist add --gateway "/abs/path/to/prxs-node/bin/node"
openclaw approvals get --gateway
```

### 7) Verify tools in the Dashboard

In the Control UI / chat, run:

1) `prxs_registry_info` (check the `bootstraps` and/or `bootstrap` field)
2) `prxs_list_services` (your provider service should appear)
3) `prxs_semantic_search(query=...)` (discovery)
4) (optional) `prxs_sync_tools` (creates `prxs_<service>` tools)
5) `prxs_prepare_call(serviceName=..., args=...)` (returns `exec`)
6) OpenClaw `exec` with the returned `exec` object → approve → get stdout
7) `prxs_parse_node_output(stdout=...)` (extract structured result)

## Sub-agents (recommended)

Use OpenClaw sub-agents to parallelize “discovery / ranking / comparison” work against the PRXS registry, but keep them **read-only** by policy.

Example `openclaw.json` fragment (allow-only, deny wins):

```json
{
  "tools": {
    "subagents": {
      "tools": {
        "allow": [
          "prxs_registry_info",
          "prxs_list_services",
          "prxs_search_services",
          "prxs_semantic_search",
          "prxs_get_service"
        ],
        "deny": ["exec", "process", "gateway", "cron"]
      }
    }
  }
}
```

This ensures sub-agents can browse/search services, but cannot execute commands or start providers.

## Remote registry notes

- If the registry is deployed behind NAT, set `PRXS_REGISTRY_BOOTSTRAP` (or `PRXS_REGISTRY_ADVERTISE_IP` / `PRXS_REGISTRY_ADVERTISE_DNS`) on the registry host so `/api/v1/registry/info` returns a usable bootstrap multiaddr.
- If you already know the bootstrap multiaddr, set `plugins.entries.prxs-mesh.config.bootstrapMultiaddr` and the plugin will not rely on `/registry/info`.

## What changed (why this works better for remote registries)

- `GET /api/v1/registry/info` now returns `bootstraps: []` (not just a single `bootstrap`) so clients have more usable connection options.
- `PRXS_REGISTRY_ADVERTISE_DNS` lets the registry emit `/dns4/...` bootstraps (better than hardcoding IPs).
- The plugin now prefers `info.bootstraps[0]` for bootstrapping.
- If you choose `execHost=node`, the plugin can include `exec.node` via `execNode` so the exec request is schema-correct.

## Trust & economics (how staking / identity plug in)

This connector is designed so OpenClaw can make *safe* calls into an *untrusted* mesh.

### 1) User approvals (always-on)

- Every service run is an `exec` request, so OpenClaw approvals can require a human click (or `/approve`).
- Your agent can still discover/search without any approvals.

### 2) Provider stake-gating (registry-side)

PRXS has a “registry gate”: providers register/heartbeat to the registry and can be stake-gated (mock or EVM). OpenClaw consumes the registry catalog, so stake-gating happens before a tool is even discoverable.

### 3) ERC-8004 identity anchors (optional)

If a service card includes:

- `agent_id` (AgentID / ERC-721 tokenId),
- `agent_registry` (Identity Registry contract address),
- `agent_uri` (optional mirror of on-chain `tokenURI`),

then the plugin can:

- verify `agent_id` on-chain (`prxs_erc8004_verify_service`)
- fetch the agent card JSON from the on-chain `agentURI` (`prxs_erc8004_fetch_agent_card`)

This is useful for “blue check”-style trust: services can be linked to an on-chain identity independent of the provider’s current libp2p peer.

### Payments

This repo currently treats `cost_per_op` as pricing metadata/UX. A full on-chain payments flow (deposits + off-chain tickets + settlement) is not wired into the OpenClaw plugin yet; implement it as a separate phase (ticket signing + registry ledger + provider redemption).
