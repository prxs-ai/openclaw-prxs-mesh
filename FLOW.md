# Full PRXS ↔ OpenClaw Flow (Registry → Tools → Approved Execution)

This document describes the end-to-end flow for using PRXS services from OpenClaw via the `prxs-mesh` plugin.

## 1) PRXS: run a registry (local or remote)

### Local (dev)

```bash
go build -o bin/registry ./cmd/registry
go build -o bin/node ./cmd/node

./bin/registry -port 5000 -api-port 8080 -dev=true
```

Check it:

```bash
curl "http://localhost:8080/api/v1/registry/info"
curl "http://localhost:8080/api/v1/services_full"
```

### Remote (recommended settings)

Run registry with `-dev=false` for WAN usage, and make sure `/api/v1/registry/info` returns a usable bootstrap multiaddr.

If you’re behind NAT/Docker and the registry can’t infer the public IP:

- Set `PRXS_REGISTRY_BOOTSTRAP` to a full multiaddr (best), or
- Set `PRXS_REGISTRY_ADVERTISE_IP` to an IP override.
- Set `PRXS_REGISTRY_ADVERTISE_DNS` to a DNS name override (so the registry can return `/dns4/...` bootstraps).

Example:

```bash
export PRXS_REGISTRY_BOOTSTRAP="/dns4/registry.example.com/udp/4001/quic-v1/p2p/12D3KooW..."

./bin/registry -port 4001 -api-port 8080 -dev=false
```

## 2) PRXS: run a provider (register a service)

```bash
./bin/node -mode provider \
  -port 6010 \
  -bootstrap "<BOOTSTRAP_MULTIADDR_FROM_REGISTRY>" \
  -agent sample_agents/calc.py \
  -stake-amount 12 \
  -stake-chain mock-l2 \
  -stake-web-port 8090
```

Provider registers + heartbeats to the registry, which makes the service discoverable via REST.

## 3) OpenClaw: install + configure the plugin

Make sure OpenClaw is installed and the Gateway is running (recommended: `openclaw onboard --install-daemon`). See `extensions/prxs-mesh/README.md` for the full OpenClaw setup steps.

Install locally:

```bash
openclaw plugins install -l ./extensions/prxs-mesh
openclaw gateway restart
```

Configure `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "prxs-mesh": {
        "enabled": true,
        "config": {
          "registryUrl": "http://localhost:8080",
          "prxsNodeBinary": "/abs/path/to/prxs-node/bin/node",
          "devMode": true
        }
      }
    }
  }
}
```

Apply config:

```bash
openclaw gateway restart
```

## 4) OpenClaw: lock execution behind approvals

Allowlist the PRXS binary (use an absolute path):

```bash
openclaw approvals allowlist add --gateway "/abs/path/to/prxs-node/bin/node"
```

Set:
- `security = allowlist`
- `ask = always`

So every service run requires a human approval.

Important:
- Exec approvals apply to `host=gateway` / `host=node` (not `sandbox`).
- The plugin returns prepared `exec.host=gateway` by default.

## 5) Chat flow: discover → prepare → approve exec → parse

### A) Discover tools from the registry

- `prxs_list_services`
- or `prxs_semantic_search(query=...)`
- (optional) `prxs_get_service(serviceName=...)`

### B) Sync per-service tools (optional)

- `prxs_sync_tools`

This registers tools like `prxs_mathoracle_v1` (name depends on the service name).

Note: `prxs_sync_tools` is registered as an optional tool; you may need to allowlist it in OpenClaw tool policy (recommended: `tools.alsoAllow` / `agents.list[].tools.alsoAllow`).

### C) Prepare a call

- Use `prxs_prepare_call(serviceName, args)` or the per-service tool.

Note: `prxs_prepare_call` is registered as an optional tool; you may need to allowlist it in OpenClaw tool policy (recommended: `tools.alsoAllow` / `agents.list[].tools.alsoAllow`).

Result includes:
- `exec` (object, ready to pass into OpenClaw `exec` as-is: `command`, `host`, `security`, `ask`)
- `execPlan.argv` (argv array)
- provider list + selected provider
- `bootstrap`

### D) Execute (user approves)

- Call OpenClaw built-in `exec` with `command: <exec.command>`.
- User approves in UI (or via `/approve` if approvals are forwarded).

Tip: you can pass the entire `exec` object returned by the plugin into OpenClaw `exec`.

### E) Parse output

- Call `prxs_parse_node_output(stdout)` to extract the `--- RESULT ---` block.

## 6) Optional trust: ERC‑8004 verification

If a service card includes `agent_id` (+ optional `agent_registry`, `agent_uri`):

- `prxs_erc8004_verify_service(serviceName)` verifies the on-chain identity anchor.
- `prxs_erc8004_fetch_agent_card(agentId)` downloads the agent card JSON from on-chain `tokenURI` (http/https only).

You can also enable automatic verification on prepare:

```json
{
  "plugins": {
    "entries": {
      "prxs-mesh": {
        "enabled": true,
        "config": {
          "erc8004RpcUrl": "https://rpc.example.com",
          "erc8004IdentityRegistry": "0x...",
          "erc8004VerifyOnPrepare": true
        }
      }
    }
  }
}
```

## 7) Optional: start a provider from OpenClaw (advanced)

If you want OpenClaw to start a new PRXS provider process:

1) Prepare:
- `prxs_prepare_spawn_provider(agentPath=...)` returns an `exec` object with `background=true`.

2) Run (user approves):
- OpenClaw `exec` with the returned `exec` object.

3) Confirm:
- Use `prxs_list_services` / `prxs_get_service` to see the new service.
