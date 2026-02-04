type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type ProviderInfo = {
  id: string;
  addrs: string[];
};

type ServiceCard = {
  name: string;
  description: string;
  inputs: string[];
  cost_per_op: number;
  version: string;
  tags?: string[];

  // Optional ERC-8004 identity anchor for trust/discovery.
  agent_id?: number;
  agent_registry?: string;
  agent_uri?: string;
};

type ServiceDescriptor = {
  card: ServiceCard;
  providers: ProviderInfo[];
};

type RegistryInfo = {
  peer_id?: string;
  multiaddrs?: string[];
  bootstraps?: string[];
  bootstrap?: string;
};

type PluginConfig = {
  registryUrl: string;
  prxsNodeBinary: string;
  bootstrapMultiaddr?: string;
  devMode?: boolean;
  defaultTopK?: number;
  cacheTtlSeconds?: number;
  autoSyncTools?: boolean;
  maxServiceTools?: number;
  toolNamePrefix?: string;

  execHost?: "sandbox" | "gateway" | "node";
  execNode?: string;
  execSecurity?: "deny" | "allowlist" | "full";
  execAsk?: "off" | "on-miss" | "always";

  erc8004RpcUrl?: string;
  erc8004IdentityRegistry?: string;
  erc8004VerifyOnPrepare?: boolean;
};

function nowMs(): number {
  return Date.now();
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function ensureApiV1BaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  // Be forgiving: allow passing the base URL ("http://host:port"),
  // the API base ("/api/v1"), or even an endpoint ("/api/v1/services").
  const m = trimmed.match(/\/api\/v1(?:\/|$)/);
  if (m && typeof m.index === "number") {
    return trimmed.slice(0, m.index + "/api/v1".length);
  }
  return `${trimmed}/api/v1`;
}

function isLocalHostName(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function isLocalRegistryUrl(url: string): boolean {
  const raw = url.trim();
  if (!raw) return false;
  try {
    return isLocalHostName(new URL(raw).hostname);
  } catch {
    // Allow passing "localhost:8080" (no scheme)
    try {
      return isLocalHostName(new URL(`http://${raw}`).hostname);
    } catch {
      return false;
    }
  }
}

function isLocalMultiaddr(addr: string): boolean {
  // Registry may include loopback addresses in /api/v1/registry/info; avoid picking them for remote registries.
  return (
    addr.includes("/ip4/127.0.0.1/") ||
    addr.includes("/ip4/localhost/") ||
    addr.includes("/ip6/::1/") ||
    addr.includes("/dns4/localhost/") ||
    addr.includes("/dns6/localhost/")
  );
}

function safeJsonStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function isSafePosixWord(value: string): boolean {
  // Conservative allowlist of characters that don't need quoting in POSIX sh.
  // Anything else will be single-quoted.
  return /^[A-Za-z0-9_.,/:@+=-]+$/.test(value);
}

function shellQuotePosix(value: string): string {
  if (value.length === 0) return "''";
  const repl = `'\\''`; // close ', escape ', reopen
  return `'${value.replace(/'/g, repl)}'`;
}

function formatCommandPosix(argv: string[]): string {
  return argv.map((a) => (isSafePosixWord(a) ? a : shellQuotePosix(a))).join(" ");
}

function isWindowsRuntime(): boolean {
  const g: any = globalThis as any;
  const platform = g?.process?.platform ?? g?.Deno?.build?.os ?? null;
  return platform === "win32" || platform === "windows";
}

// Equivalent to Python's subprocess.list2cmdline / CreateProcess quoting rules.
function quoteArgWindows(arg: string): string {
  if (arg.length === 0) return '""';
  const needsQuotes = /[\s\t\n\v"]/.test(arg);
  if (!needsQuotes) return arg;

  let out = '"';
  let backslashes = 0;

  for (let i = 0; i < arg.length; i += 1) {
    const ch = arg[i];
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }

    if (ch === '"') {
      // Escape all backslashes and the quote
      out += "\\".repeat(backslashes * 2 + 1);
      out += '"';
      backslashes = 0;
      continue;
    }

    if (backslashes > 0) {
      out += "\\".repeat(backslashes);
      backslashes = 0;
    }
    out += ch;
  }

  // Escape trailing backslashes (they would otherwise escape the closing quote)
  if (backslashes > 0) {
    out += "\\".repeat(backslashes * 2);
  }

  out += '"';
  return out;
}

function formatCommandWindows(argv: string[]): string {
  return argv.map(quoteArgWindows).join(" ");
}

function formatCommand(argv: string[]): string {
  return isWindowsRuntime() ? formatCommandWindows(argv) : formatCommandPosix(argv);
}

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function sanitizeToolSuffix(serviceName: string): string {
  const lowered = serviceName.toLowerCase();
  const cleaned = lowered
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!cleaned) return "service";
  if (/^[0-9]/.test(cleaned)) return `s_${cleaned}`;
  return cleaned;
}

function sanitizeToolPrefix(prefix: string | null | undefined): string {
  const lowered = String(prefix ?? "").toLowerCase();
  const cleaned = lowered
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  if (!cleaned) return "prxs_";
  const normalized = /^[0-9]/.test(cleaned) ? `p_${cleaned}` : cleaned;
  return normalized.endsWith("_") ? normalized : `${normalized}_`;
}

function buildParametersFromInputs(card: ServiceCard): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const required: string[] = [];

  for (const name of card.inputs || []) {
    const key = String(name);
    props[key] = {
      type: "string",
      description: `Argument '${key}' for service ${card.name}`,
    };
    required.push(key);
  }

  const additionalProperties = required.length === 0;
  return {
    type: "object",
    properties: props,
    required,
    additionalProperties,
  };
}

function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function normalizeHexAddress(value: string): string {
  const trimmed = value.trim();
  if (!isHexAddress(trimmed)) {
    throw new Error(`Invalid EVM address: ${value}`);
  }
  return `0x${trimmed.slice(2).toLowerCase()}`;
}

function asExecHost(value: unknown): "sandbox" | "gateway" | "node" | null {
  if (value === "sandbox" || value === "gateway" || value === "node") return value;
  return null;
}

function asExecSecurity(value: unknown): "deny" | "allowlist" | "full" | null {
  if (value === "deny" || value === "allowlist" || value === "full") return value;
  return null;
}

function asExecAsk(value: unknown): "off" | "on-miss" | "always" | null {
  if (value === "off" || value === "on-miss" || value === "always") return value;
  return null;
}

function encodeUint256(value: bigint): string {
  if (value < 0n) throw new Error("uint256 must be >= 0");
  let hex = value.toString(16);
  if (hex.length > 64) throw new Error("uint256 overflow");
  hex = hex.padStart(64, "0");
  return hex;
}

function encodeBytes32(hexNo0x: string): string {
  const cleaned = hexNo0x.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error("invalid hex");
  if (cleaned.length > 64) throw new Error("bytes32 too long");
  return cleaned.padStart(64, "0");
}

function encodeAbiString(value: string): { head: string; tail: string } {
  const buf = Buffer.from(value, "utf8");
  const len = BigInt(buf.length);
  const lenHex = encodeUint256(len);
  const dataHex = buf.toString("hex");
  const pad = (64 - (dataHex.length % 64)) % 64;
  const paddedDataHex = `${dataHex}${"0".repeat(pad)}`;
  return { head: "", tail: `${lenHex}${paddedDataHex}` };
}

function encodeCallData_OneUint(selectorHex: string, arg: bigint): string {
  const selector = selectorHex.replace(/^0x/, "");
  if (selector.length !== 8) throw new Error(`invalid selector: ${selectorHex}`);
  return `0x${selector}${encodeUint256(arg)}`;
}

function encodeCallData_UintString(selectorHex: string, arg0: bigint, arg1: string): string {
  const selector = selectorHex.replace(/^0x/, "");
  if (selector.length !== 8) throw new Error(`invalid selector: ${selectorHex}`);

  // Head: arg0 + offset-to-string (0x40)
  const head0 = encodeUint256(arg0);
  const head1 = encodeUint256(0x40n);
  const { tail } = encodeAbiString(arg1);
  return `0x${selector}${head0}${head1}${tail}`;
}

function decodeUint256FromWords(hexNo0x: string, wordIndex: number): bigint {
  const start = wordIndex * 64;
  const word = hexNo0x.slice(start, start + 64);
  if (word.length !== 64) throw new Error("return data too short");
  return BigInt(`0x${word}`);
}

function decodeAddressFromReturnData(hexData: string): string {
  const hexNo0x = hexData.replace(/^0x/, "");
  if (hexNo0x.length < 64) throw new Error("return data too short");
  const word = hexNo0x.slice(0, 64);
  const addr = word.slice(24 * 2);
  return `0x${addr.toLowerCase()}`;
}

function decodeDynamicBytesFromReturnData(hexData: string): Buffer {
  const hexNo0x = hexData.replace(/^0x/, "");
  if (hexNo0x.length < 64) throw new Error("return data too short");
  const offset = decodeUint256FromWords(hexNo0x, 0);
  const offsetBytes = Number(offset);
  if (!Number.isFinite(offsetBytes) || offsetBytes < 0) throw new Error("invalid offset");

  const offsetHex = offsetBytes * 2;
  if (offsetHex + 64 > hexNo0x.length) throw new Error("return data too short (offset)");
  const lenWord = hexNo0x.slice(offsetHex, offsetHex + 64);
  if (lenWord.length !== 64) throw new Error("return data too short (len)");
  const len = Number(BigInt(`0x${lenWord}`));
  if (!Number.isFinite(len) || len < 0) throw new Error("invalid length");

  const dataStart = offsetHex + 64;
  const dataEnd = dataStart + len * 2;
  if (dataEnd > hexNo0x.length) throw new Error("return data too short (data)");
  const dataHex = hexNo0x.slice(dataStart, dataEnd);
  if (dataHex.length !== len * 2) throw new Error("return data too short (bytes)");
  return Buffer.from(dataHex, "hex");
}

function decodeStringFromReturnData(hexData: string): string {
  return decodeDynamicBytesFromReturnData(hexData).toString("utf8");
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} on ${url}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonRpc(rpcUrl: string, body: any, timeoutMs = 5000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} on ${rpcUrl}: ${text.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function ethCall(rpcUrl: string, to: string, data: string, timeoutMs = 7000): Promise<string> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to, data }, "latest"],
  };
  const resp = await fetchJsonRpc(rpcUrl, payload, timeoutMs);
  if (resp?.error) {
    throw new Error(resp.error?.message ?? "eth_call failed");
  }
  const result = String(resp?.result ?? "");
  if (!/^0x[0-9a-fA-F]*$/.test(result)) {
    throw new Error(`Invalid eth_call result: ${result}`);
  }
  return result;
}

function normalizeProviders(raw: any): ProviderInfo[] {
  const providersRaw: any[] = Array.isArray(raw) ? raw : [];
  return providersRaw.map((p) => {
    const id = String(p?.ID ?? p?.id ?? "");
    const addrs = Array.isArray(p?.Addrs)
      ? p.Addrs.map((a: any) => String(a))
      : Array.isArray(p?.addrs)
        ? p.addrs.map((a: any) => String(a))
        : [];
    return { id, addrs };
  });
}

function normalizeServiceDescriptor(name: string, entry: any): ServiceDescriptor {
  const hasCard = entry && typeof entry === "object" && entry.card;
  const cardRaw = hasCard ? entry.card : { name };
  const providersRaw = hasCard ? entry.providers : entry;

  const card: ServiceCard = {
    name: String(cardRaw?.name ?? name),
    description: String(cardRaw?.description ?? ""),
    inputs: Array.isArray(cardRaw?.inputs) ? cardRaw.inputs.map((x: any) => String(x)) : [],
    cost_per_op: Number(cardRaw?.cost_per_op ?? 0),
    version: String(cardRaw?.version ?? "1.0.0"),
    tags: Array.isArray(cardRaw?.tags) ? cardRaw.tags.map((x: any) => String(x)) : undefined,

    agent_id: Number.isFinite(cardRaw?.agent_id) ? Number(cardRaw.agent_id) : undefined,
    agent_registry: typeof cardRaw?.agent_registry === "string" ? cardRaw.agent_registry : undefined,
    agent_uri: typeof cardRaw?.agent_uri === "string" ? cardRaw.agent_uri : undefined,
  };

  return {
    card,
    providers: normalizeProviders(providersRaw),
  };
}

function extractResultBlock(stdout: string): string {
  const marker = "--- RESULT ---";
  const end = "--------------";
  const idx = stdout.indexOf(marker);
  if (idx === -1) return stdout.trim();
  const after = stdout.slice(idx + marker.length);
  const endIdx = after.indexOf(end);
  const block = endIdx === -1 ? after : after.slice(0, endIdx);
  return block.trim();
}

export default function prxsMeshPlugin(api: any) {
  // OpenClaw 2026.x passes per-plugin config via `api.pluginConfig`.
  // Keep `api.config` as a backwards-compatible fallback.
  const cfg = (api?.pluginConfig ?? api?.config ?? {}) as PluginConfig;
  const logger = api?.logger ?? console;

  const config: PluginConfig = {
    registryUrl: cfg.registryUrl || "http://localhost:8080",
    prxsNodeBinary: asNonEmptyString(cfg.prxsNodeBinary ?? "") ?? "./bin/node",
    bootstrapMultiaddr: asNonEmptyString(cfg.bootstrapMultiaddr ?? "") ?? undefined,
    devMode: typeof cfg.devMode === "boolean" ? cfg.devMode : true,
    defaultTopK: typeof cfg.defaultTopK === "number" ? cfg.defaultTopK : 5,
    cacheTtlSeconds: typeof cfg.cacheTtlSeconds === "number" ? cfg.cacheTtlSeconds : 10,
    autoSyncTools: typeof cfg.autoSyncTools === "boolean" ? cfg.autoSyncTools : true,
    maxServiceTools: typeof cfg.maxServiceTools === "number" ? cfg.maxServiceTools : 200,
    toolNamePrefix: sanitizeToolPrefix(asNonEmptyString(cfg.toolNamePrefix ?? "prxs_") ?? "prxs_"),

    execHost: asExecHost(cfg.execHost) ?? "gateway",
    execNode: asNonEmptyString(cfg.execNode ?? "") ?? undefined,
    execSecurity: asExecSecurity(cfg.execSecurity) ?? "allowlist",
    execAsk: asExecAsk(cfg.execAsk) ?? "always",

    erc8004RpcUrl: asNonEmptyString(cfg.erc8004RpcUrl ?? "") ?? undefined,
    erc8004IdentityRegistry: asNonEmptyString(cfg.erc8004IdentityRegistry ?? "") ?? undefined,
    erc8004VerifyOnPrepare: typeof cfg.erc8004VerifyOnPrepare === "boolean" ? cfg.erc8004VerifyOnPrepare : false,
  };

  const baseUrl = ensureApiV1BaseUrl(config.registryUrl);

  const cache = {
    registryInfo: { value: null as RegistryInfo | null, expiresAt: 0 },
    services: { value: null as Record<string, ServiceDescriptor> | null, expiresAt: 0 },
  };

  const registeredToolNames = new Set<string>();

  async function erc8004GetAgent(agentIdNum: number, registryOverride?: string | null) {
    const rpcUrl = config.erc8004RpcUrl;
    if (!rpcUrl) {
      throw new Error("erc8004RpcUrl is not configured");
    }

    const registryAddrRaw = asNonEmptyString(registryOverride ?? "") ?? config.erc8004IdentityRegistry;
    if (!registryAddrRaw) {
      throw new Error("erc8004IdentityRegistry is not configured");
    }
    const registryAddr = normalizeHexAddress(registryAddrRaw);

    const agentId = BigInt(Math.trunc(agentIdNum));
    if (agentId <= 0n) throw new Error("agentId must be > 0");

    // Selectors (hardcoded):
    // - ownerOf(uint256): 0x6352211e
    // - tokenURI(uint256): 0xc87b56dd
    // - getMetadata(uint256,string): 0xcb4799f2 (PRXS ERC8004IdentityRegistry extension)
    const owner = decodeAddressFromReturnData(
      await ethCall(rpcUrl, registryAddr, encodeCallData_OneUint("0x6352211e", agentId)),
    );

    const agentURI = decodeStringFromReturnData(
      await ethCall(rpcUrl, registryAddr, encodeCallData_OneUint("0xc87b56dd", agentId)),
    );

    let agentWallet: string | null = null;
    try {
      const walletBytes = decodeDynamicBytesFromReturnData(
        await ethCall(rpcUrl, registryAddr, encodeCallData_UintString("0xcb4799f2", agentId, "agentWallet")),
      );
      // Accept either 20-byte encodePacked(address) or 32-byte ABI-encoded address.
      let addrBytes: Buffer | null = null;
      if (walletBytes.length === 20) {
        addrBytes = walletBytes;
      } else if (walletBytes.length === 32) {
        addrBytes = walletBytes.subarray(12);
      }
      if (addrBytes && addrBytes.length === 20) {
        const hex = addrBytes.toString("hex");
        if (!/^0+$/.test(hex)) {
          agentWallet = `0x${hex}`;
        }
      }
    } catch {
      // ignore - metadata may be absent / not supported
    }

    return {
      registry: registryAddr,
      agentId: Number(agentId),
      owner,
      agentURI,
      agentWallet,
    };
  }

  async function getRegistryInfoCached(): Promise<RegistryInfo> {
    const ttlMs = Math.max(0, config.cacheTtlSeconds || 0) * 1000;
    const isFresh = cache.registryInfo.value && nowMs() < cache.registryInfo.expiresAt;
    if (isFresh) return cache.registryInfo.value!;

    const info = (await fetchJson(`${baseUrl}/registry/info`)) as RegistryInfo;
    cache.registryInfo = { value: info, expiresAt: nowMs() + ttlMs };
    return info;
  }

  async function getServicesCached(): Promise<Record<string, ServiceDescriptor>> {
    const ttlMs = Math.max(0, config.cacheTtlSeconds || 0) * 1000;
    const isFresh = cache.services.value && nowMs() < cache.services.expiresAt;
    if (isFresh) return cache.services.value!;

    let servicesRaw: any = null;
    let usedPath: string | null = null;
    let lastErr: any = null;
    for (const path of ["services_full", "services"]) {
      try {
        const data = await fetchJson(`${baseUrl}/${path}`);
        const services = data?.services;
        if (!services || typeof services !== "object" || Array.isArray(services)) {
          throw new Error(`Invalid response from ${baseUrl}/${path}: missing 'services' object`);
        }
        servicesRaw = services;
        usedPath = path;
        break;
      } catch (err) {
        lastErr = err;
        if (path === "services_full") {
          logger.warn?.(`[prxs-mesh] Failed to fetch ${baseUrl}/services_full; falling back to /services. Error: ${String(err)}`);
        }
      }
    }
    if (!servicesRaw || typeof servicesRaw !== "object") {
      throw new Error(`Failed to fetch services from registry: ${String(lastErr ?? "unknown error")}`);
    }
    if (usedPath === "services") {
      logger.warn?.(
        `[prxs-mesh] Using ${baseUrl}/services fallback (no ServiceCard data). Service inputs may be empty; prefer /services_full.`,
      );
    }

    const out: Record<string, ServiceDescriptor> = {};
    for (const [name, entry] of Object.entries(servicesRaw)) {
      out[String(name)] = normalizeServiceDescriptor(String(name), entry);
    }

    cache.services = { value: out, expiresAt: nowMs() + ttlMs };
    return out;
  }

  async function resolveService(name: string): Promise<ServiceDescriptor> {
    const services = await getServicesCached();
    if (services[name]) return services[name];
    const targetLower = name.toLowerCase();
    for (const [k, v] of Object.entries(services)) {
      if (k.toLowerCase() === targetLower) return v;
      if ((v.card?.name || "").toLowerCase() === targetLower) return v;
    }
    throw new Error(`Service '${name}' not found in registry`);
  }

  async function resolveBootstrap(): Promise<string> {
    if (config.bootstrapMultiaddr && config.bootstrapMultiaddr.trim().length) {
      return config.bootstrapMultiaddr.trim();
    }
    const info = await getRegistryInfoCached();
    const bootstraps = Array.isArray(info.bootstraps) ? info.bootstraps.map(String) : [];
    const multiaddrs = Array.isArray(info.multiaddrs) ? info.multiaddrs.map(String) : [];

    const candidates = [
      ...bootstraps,
      String(info.bootstrap ?? ""),
      ...multiaddrs,
    ]
      .map(asNonEmptyString)
      .filter((x): x is string => Boolean(x));

    const preferLocalhost = isLocalRegistryUrl(config.registryUrl) || isLocalRegistryUrl(baseUrl);

    if (!preferLocalhost) {
      const nonLocal = candidates.find((b) => !isLocalMultiaddr(b));
      if (nonLocal) return nonLocal;
    }

    const local = candidates.find((b) => isLocalMultiaddr(b));
    if (local) return local;

    if (candidates.length) return candidates[0];

    throw new Error("Unable to resolve bootstrap multiaddr (set bootstrapMultiaddr in plugin config)");
  }

  function buildExecPlan(service: ServiceDescriptor, payload: unknown) {
    const argv: string[] = [
      config.prxsNodeBinary,
      "-mode",
      "client",
      "-bootstrap",
      "__BOOTSTRAP__",
      "-query",
      service.card.name,
      "-args",
      safeJsonStringify(payload),
    ];

    if (!config.devMode) {
      argv.push("-dev=false");
    }

    return {
      argv,
    };
  }

  async function prepareCall(serviceName: string, params: any, argsJson?: string | null) {
    const svc = await resolveService(serviceName);
    const bootstrap = await resolveBootstrap();

    logger.info?.(`[prxs-mesh] prepareCall: serviceName=${serviceName}, params=${JSON.stringify(params)}, inputs=${JSON.stringify(svc.card.inputs)}`);

    // CRITICAL: Prefer array payload for services that declare `inputs`.
    let rawPayload: any = params;
    if (argsJson && argsJson.trim().length) {
      rawPayload = JSON.parse(argsJson);
      logger.info?.(`[prxs-mesh] Using argsJson: ${argsJson}`);
    }

    let payload: unknown;
    if (svc.card.inputs && svc.card.inputs.length > 0) {
      const inputs = svc.card.inputs;
      if (Array.isArray(rawPayload)) {
        payload = rawPayload;
        logger.info?.(`[prxs-mesh] payload already array: ${JSON.stringify(payload)}`);
      } else if (rawPayload && typeof rawPayload === "object") {
        payload = inputs.map((k: string) => (rawPayload[k] !== undefined ? rawPayload[k] : null));
        logger.info?.(`[prxs-mesh] Converted object to array: ${JSON.stringify(payload)}`);
      } else {
        const arr = inputs.map(() => null);
        if (arr.length > 0 && rawPayload !== undefined) {
          arr[0] = rawPayload;
        }
        payload = arr;
        logger.info?.(`[prxs-mesh] Coerced scalar/null to array: ${JSON.stringify(payload)}`);
      }
    } else {
      payload = rawPayload ?? {};
      logger.info?.(`[prxs-mesh] Using payload as-is (no inputs): ${JSON.stringify(payload)}`);
    }

    const providers = svc.providers || [];
    const selectedProvider = providers.length ? providers[0] : null;

    const execPlan = buildExecPlan(svc, payload);
    const bootstrapIdx = execPlan.argv.indexOf("__BOOTSTRAP__");
    if (bootstrapIdx === -1) {
      throw new Error("Internal error: exec plan bootstrap placeholder missing");
    }
    execPlan.argv[bootstrapIdx] = bootstrap;

    const exec = {
      command: formatCommand(execPlan.argv),
      host: config.execHost ?? "gateway",
      security: config.execSecurity ?? "allowlist",
      ask: config.execAsk ?? "always",
    };
    if (exec.host === "node" && config.execNode) {
      (exec as any).node = config.execNode;
    }

    let erc8004: any = null;
    if (config.erc8004VerifyOnPrepare && Number(svc.card.agent_id || 0) > 0) {
      try {
        erc8004 = await erc8004GetAgent(Number(svc.card.agent_id), svc.card.agent_registry ?? null);
        const cardUri = asNonEmptyString(svc.card.agent_uri ?? "");
        if (cardUri) {
          erc8004.matchesServiceCardURI = erc8004.agentURI === cardUri;
        }
      } catch (err) {
        erc8004 = { error: String(err) };
      }
    }

    return {
      registry: { baseUrl },
      service: svc.card,
      providers,
      selectedProvider,
      bootstrap,
      execPlan,
      exec,
      erc8004,
    };
  }

  async function syncServiceTools(limit?: number): Promise<{ added: number; total: number }> {
    const services = await getServicesCached();
    const entries = Object.values(services);
    const max = Math.max(0, limit ?? config.maxServiceTools ?? 200);

    let added = 0;
    const prefix = config.toolNamePrefix || "prxs_";

    for (const svc of entries.slice(0, max)) {
      const suffix = sanitizeToolSuffix(svc.card.name);
      let toolName = `${prefix}${suffix}`;
      if (registeredToolNames.has(toolName)) {
        toolName = `${prefix}${suffix}__svc`;
      }
      if (registeredToolNames.has(toolName)) continue;

      try {
        api.registerTool(
          {
            name: toolName,
            description: svc.card.description || `PRXS service '${svc.card.name}'`,
            parameters: buildParametersFromInputs(svc.card),
            async execute(_id: string, callParams: any) {
              const prepared = await prepareCall(svc.card.name, callParams, null);
              // Only include essential fields - exclude providers to avoid LLM confusion
              // (providers contain localhost multiaddrs that LLMs misinterpret as HTTP endpoints)
              const out = {
                service: prepared.service,
                exec: prepared.exec,
                bootstrap: prepared.bootstrap,
                instruction: "IMPORTANT: Use OpenClaw exec tool with the 'exec.command' below. Do NOT curl or make HTTP requests to any addresses.",
                next: "Run OpenClaw exec with the exec.command (user should approve), then call prxs_parse_node_output to parse the result.",
              };
              return textResult(safeJsonStringify(out));
            },
          },
          {},
        );
      } catch (err) {
        logger.warn?.(`[prxs-mesh] failed to register tool ${toolName}: ${String(err)}`);
        continue;
      }

      registeredToolNames.add(toolName);
      added += 1;
    }

    return { added, total: entries.length };
  }

  api.registerTool({
    name: "prxs_registry_info",
    description: "Fetch PRXS registry info (/api/v1/registry/info).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id: string) {
      const info = await getRegistryInfoCached();
      return textResult(safeJsonStringify({ registry: { baseUrl }, info }));
    },
  });
  registeredToolNames.add("prxs_registry_info");

  api.registerTool({
    name: "prxs_list_services",
    description: "List PRXS services from the registry (prefers /services_full).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id: string) {
      const services = await getServicesCached();
      const cards = Object.values(services).map((s) => s.card);
      return textResult(safeJsonStringify({ registry: { baseUrl }, count: cards.length, services: cards }));
    },
  });
  registeredToolNames.add("prxs_list_services");

  api.registerTool({
    name: "prxs_get_service",
    description: "Get PRXS service details by service name. To CALL the service, use prxs_prepare_call or the per-service tool (prxs_<ServiceName>).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        serviceName: { type: "string", description: "Service name (case-insensitive match supported)." },
      },
      required: ["serviceName"],
    },
    async execute(_id: string, params: any) {
      const serviceName = String(params?.serviceName ?? "");
      const svc = await resolveService(serviceName);
      // Do NOT return providers - they contain localhost multiaddrs that LLMs misinterpret as HTTP endpoints
      // Instead, guide LLM to use prxs_prepare_call or per-service tools
      return textResult(safeJsonStringify({
        registry: { baseUrl },
        service: svc.card,
        providerCount: (svc.providers || []).length,
        instruction: "To call this service, use prxs_prepare_call or the per-service tool (e.g., prxs_TavilySearch_v1). Do NOT make HTTP requests to provider addresses.",
      }));
    },
  });
  registeredToolNames.add("prxs_get_service");

  api.registerTool({
    name: "prxs_search_services",
    description: "Search PRXS services by name (partial match) via /services/search?q=...",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Search query." },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      const q = String(params?.query ?? "");
      const data = await fetchJson(`${baseUrl}/services/search?q=${encodeURIComponent(q)}`);
      return textResult(safeJsonStringify(data));
    },
  });
  registeredToolNames.add("prxs_search_services");

  api.registerTool({
    name: "prxs_semantic_search",
    description: "Semantic search PRXS services via /services/semantic_search?q=...&k=...",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", description: "Natural language query." },
        k: { type: "integer", description: "Number of results.", minimum: 1, maximum: 50 },
      },
      required: ["query"],
    },
    async execute(_id: string, params: any) {
      const q = String(params?.query ?? "");
      const k = Number.isFinite(params?.k) ? Number(params.k) : config.defaultTopK ?? 5;
      const data = await fetchJson(`${baseUrl}/services/semantic_search?q=${encodeURIComponent(q)}&k=${encodeURIComponent(String(k))}`);
      return textResult(safeJsonStringify(data));
    },
  });
  registeredToolNames.add("prxs_semantic_search");

  api.registerTool(
    {
      name: "prxs_sync_tools",
      description: "Fetch services from the PRXS registry and register per-service tools (prxs_<serviceName>).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 0, maximum: 5000, description: "Max number of service tools to register." },
        },
      },
      async execute(_id: string, params: any) {
        const result = await syncServiceTools(typeof params?.limit === "number" ? params.limit : undefined);
        return textResult(
          safeJsonStringify({
            registry: { baseUrl },
            ...result,
            note: "Call a prxs_<service> tool to prepare an exec request, then run it via the built-in exec tool for approvals.",
          }),
        );
      },
    },
    {},
  );
  registeredToolNames.add("prxs_sync_tools");

  api.registerTool(
    {
      name: "prxs_prepare_call",
      description: "Prepare a PRXS mesh service call and return an exec request (run it via the built-in exec tool for approvals).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          serviceName: { type: "string", description: "Exact service name (case-insensitive match supported)." },
          args: { type: "object", description: "Arguments object (string values recommended).", additionalProperties: true },
          argsJson: { type: "string", description: "Raw JSON payload string. If set, overrides args." }
        },
        required: ["serviceName"],
      },
      async execute(_id: string, params: any) {
        const serviceName = String(params?.serviceName ?? "");
        const args = (params?.args ?? {}) as JsonValue;
        const argsJson = asNonEmptyString(params?.argsJson);
        const prepared = await prepareCall(serviceName, args, argsJson);
        // Only include essential fields - exclude providers to avoid LLM confusion
        // (providers contain localhost multiaddrs that LLMs misinterpret as HTTP endpoints)
        return textResult(
          safeJsonStringify({
            service: prepared.service,
            exec: prepared.exec,
            bootstrap: prepared.bootstrap,
            instruction: "IMPORTANT: Use OpenClaw exec tool with the 'exec.command' below. Do NOT curl or make HTTP requests to any addresses.",
            next: "Run OpenClaw exec with the exec.command (user should approve), then call prxs_parse_node_output to parse the result.",
          }),
        );
      },
    },
    {},
  );
  registeredToolNames.add("prxs_prepare_call");

  api.registerTool(
    {
      name: "prxs_prepare_spawn_provider",
      description: "Prepare a command to start a PRXS provider node (long-running; run via exec approvals).",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          agentPath: { type: "string", description: "Path to a Python agent (e.g. sample_agents/calc.py)." },
          port: { type: "integer", minimum: 1, maximum: 65535, description: "libp2p listen port for the provider." },
          keyFile: { type: "string", description: "Optional key file path (e.g. node.key)." },

          stakeMode: { type: "string", description: "mock or evm", enum: ["mock", "evm"] },
          stakeProofPath: { type: "string", description: "Stake proof file path (provider only)." },
          stakeWebPort: { type: "integer", minimum: 1, maximum: 65535, description: "Local staking helper UI port." },

          // Mock mode params
          stakeAmount: { type: "number", description: "Mock stake amount (mock mode only)." },
          stakeChain: { type: "string", description: "Mock chain id (mock mode only)." },
          stakeAddress: { type: "string", description: "Display address for staking UI (mock mode only)." },

          // EVM mode params
          evmChainId: { type: "integer", description: "EVM chain id (evm mode only)." },
          stakingContract: { type: "string", description: "PRXSStaking contract address (evm mode only)." },
        },
        required: ["agentPath"],
      },
      async execute(_id: string, params: any) {
        const agentPath = String(params?.agentPath ?? "").trim();
        if (!agentPath) throw new Error("agentPath is required");

        const port = Number.isFinite(params?.port) ? Number(params.port) : 6010;
        const keyFile = asNonEmptyString(params?.keyFile);

        const stakeMode = params?.stakeMode === "evm" ? "evm" : "mock";
        const stakeProofPath = asNonEmptyString(params?.stakeProofPath) ?? "stake_proof.json";
        const stakeWebPort = Number.isFinite(params?.stakeWebPort) ? Number(params.stakeWebPort) : 8090;

        const stakeAmount = Number.isFinite(params?.stakeAmount) ? Number(params.stakeAmount) : 12;
        const stakeChain = asNonEmptyString(params?.stakeChain) ?? "mock-l2";
        const stakeAddress = asNonEmptyString(params?.stakeAddress) ?? "0xDEADBEEF00000000000000000000000000DEMO";

        const evmChainId = Number.isFinite(params?.evmChainId) ? Number(params.evmChainId) : 11155111;
        const stakingContract = asNonEmptyString(params?.stakingContract);

        const bootstrap = await resolveBootstrap();

        const argv: string[] = [
          config.prxsNodeBinary,
          "-mode",
          "provider",
          "-port",
          String(port),
          "-bootstrap",
          bootstrap,
          "-agent",
          agentPath,
        ];

        if (!config.devMode) {
          argv.push("-dev=false");
        }

        if (keyFile) {
          argv.push("-key", keyFile);
        }

        argv.push("-stake-mode", stakeMode);
        argv.push("-stake-proof", stakeProofPath);
        argv.push("-stake-web-port", String(stakeWebPort));

        if (stakeMode === "evm") {
          if (!stakingContract) {
            throw new Error("stakingContract is required when stakeMode='evm'");
          }
          argv.push("-evm-chain-id", String(evmChainId));
          argv.push("-staking-contract", stakingContract);
        } else {
          argv.push("-stake-amount", String(stakeAmount));
          argv.push("-stake-chain", stakeChain);
          argv.push("-stake-address", stakeAddress);
        }

        const execPlan = { argv };
        const exec = {
          command: formatCommand(argv),
          host: config.execHost ?? "gateway",
          security: config.execSecurity ?? "allowlist",
          ask: config.execAsk ?? "always",
          ...(config.execHost === "node" && config.execNode ? { node: config.execNode } : {}),
          background: true,
          // Provider nodes are long-running. Keep a large timeout; adjust to your environment.
          timeout: 86400,
          yieldMs: 1000,
        };

        return textResult(
          safeJsonStringify({
            registry: { baseUrl },
            bootstrap,
            execPlan,
            exec,
            next: "Run OpenClaw exec with prepared.exec to start the provider. Then confirm registration via prxs_get_service / prxs_list_services.",
          }),
        );
      },
    },
    {},
  );
  registeredToolNames.add("prxs_prepare_spawn_provider");

  api.registerTool({
    name: "prxs_parse_node_output",
    description: "Parse cmd/node stdout and extract the --- RESULT --- block (JSON-decodes when possible).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        stdout: { type: "string", description: "stdout from the exec tool." },
      },
      required: ["stdout"],
    },
    async execute(_id: string, params: any) {
      const stdout = String(params?.stdout ?? "");
      const block = extractResultBlock(stdout);
      try {
        return textResult(safeJsonStringify({ result: JSON.parse(block) }));
      } catch {
        return textResult(safeJsonStringify({ result: block }));
      }
    },
  });
  registeredToolNames.add("prxs_parse_node_output");

  api.registerTool({
    name: "prxs_erc8004_get_agent",
    description: "Fetch ERC-8004 agent identity info (owner, agentURI, agentWallet) via eth_call.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "integer", minimum: 1, description: "ERC-8004 Agent ID (ERC-721 tokenId)." },
        identityRegistry: { type: "string", description: "Optional override for the Identity Registry contract address." },
      },
      required: ["agentId"],
    },
    async execute(_id: string, params: any) {
      const agentId = Number(params?.agentId ?? 0);
      const identityRegistry = asNonEmptyString(params?.identityRegistry);
      const info = await erc8004GetAgent(agentId, identityRegistry ?? null);
      return textResult(safeJsonStringify(info));
    },
  });
  registeredToolNames.add("prxs_erc8004_get_agent");

  api.registerTool({
    name: "prxs_erc8004_verify_service",
    description: "Verify a PRXS service's ERC-8004 identity anchor using service.card.agent_id (+ optional agent_registry/agent_uri).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        serviceName: { type: "string", description: "PRXS service name." },
      },
      required: ["serviceName"],
    },
    async execute(_id: string, params: any) {
      const serviceName = String(params?.serviceName ?? "");
      const svc = await resolveService(serviceName);
      const agentId = Number(svc.card.agent_id || 0);
      if (!Number.isFinite(agentId) || agentId <= 0) {
        return textResult(
          safeJsonStringify({
            service: svc.card,
            erc8004: { status: "missing_agent_id" },
          }),
        );
      }

      const info = await erc8004GetAgent(agentId, svc.card.agent_registry ?? null);
      const cardUri = asNonEmptyString(svc.card.agent_uri ?? "");
      const matchesServiceCardURI = cardUri ? info.agentURI === cardUri : null;

      return textResult(
        safeJsonStringify({
          service: svc.card,
          erc8004: {
            ...info,
            serviceCardURI: cardUri,
            matchesServiceCardURI,
          },
        }),
      );
    },
  });
  registeredToolNames.add("prxs_erc8004_verify_service");

  api.registerTool({
    name: "prxs_erc8004_fetch_agent_card",
    description: "Fetch an ERC-8004 agentURI (tokenURI) and download the agent card JSON (http/https only).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agentId: { type: "integer", minimum: 1, description: "ERC-8004 Agent ID (ERC-721 tokenId)." },
        identityRegistry: { type: "string", description: "Optional override for the Identity Registry contract address." },
      },
      required: ["agentId"],
    },
    async execute(_id: string, params: any) {
      const agentId = Number(params?.agentId ?? 0);
      const identityRegistry = asNonEmptyString(params?.identityRegistry);
      const info = await erc8004GetAgent(agentId, identityRegistry ?? null);
      const uri = String(info.agentURI || "");

      if (!(uri.startsWith("http://") || uri.startsWith("https://"))) {
        return textResult(
          safeJsonStringify({
            agent: info,
            error: `Unsupported agentURI scheme (only http/https): ${uri}`,
          }),
        );
      }

      const card = await fetchJson(uri, 7000);
      return textResult(safeJsonStringify({ agent: info, agentCard: card }));
    },
  });
  registeredToolNames.add("prxs_erc8004_fetch_agent_card");

  if (config.autoSyncTools) {
    void syncServiceTools().then(
      (res) => logger.info?.(`[prxs-mesh] synced ${res.added}/${res.total} service tools`),
      (err) => logger.warn?.(`[prxs-mesh] tool sync failed: ${String(err)}`),
    );
  }
}
