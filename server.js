#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const receiptSchema = JSON.parse(readFileSync(new URL("./schema/receipt.schema.json", import.meta.url), "utf8"));
const RECEIPT_FIELDS = ["orderId", "paymentHash", "preimage", "fundingArkTxid", "fundingOutpoint", "finalStatus", "providerStatus", "explorers", "quote", "option", "dryRun", "warning"];
const SAFE_CONFIG_KEYS = new Set(["owner", "expectedArkAddress", "expectedOffchainScript", "nodeUrl", "signerV4Url", "signerOriginUrl", "intentUrl", "prepareUrl", "cosignUrl", "completeUrl", "swapKitUrl", "cardAid"]);
const SENSITIVE_KEYS = new Set(["assertion", "authdata", "cardpk33", "challengetoken", "claimsigner", "clientdata", "corepackage", "credential", "credentials", "credid", "credprofile", "fullpackage", "password", "pin", "prfscript", "privatekey", "recoverykey", "secret", "sendpackage", "serverpk33", "sigb64u"]);
const ACTIONS = ["quote", "create", "finalize", "track"];

const tool = {
  name: "0conf",
  description: "Outgoing mainnet BOLT11 payment from the existing Nuri card Arkade wallet through SwapKit. quote and track are read-only; create and finalize are dry unless execute is true.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action", "invoice", "amountSats"],
    properties: {
      action: { type: "string", enum: ACTIONS },
      invoice: { type: "string", description: "Exact mainnet BOLT11 invoice" },
      amountSats: { type: "integer", minimum: 1 },
      orderId: { type: "string", pattern: "^ord_", description: "Required for finalize and track" },
      execute: { type: "boolean", default: false, description: "Arms create or finalize; false by default" },
    },
  },
  outputSchema: receiptSchema,
};

function secretsFrom(config) {
  return Object.entries(config || {})
    .filter(([key, value]) => !SAFE_CONFIG_KEYS.has(key) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
}

function redact(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, "")) ? "[redacted]" : redact(child, secrets),
    ]));
  }
  return value;
}

function publicReceipt(value, secrets) {
  const receipt = Object.fromEntries(RECEIPT_FIELDS.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
  return redact(receipt, secrets);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("request body exceeds 1 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validateCall(params) {
  if (!params || params.name !== "0conf") throw new Error("unknown tool; the only tool is 0conf");
  const args = params.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments object required");
  for (const key of Object.keys(args)) {
    if (!["action", "invoice", "amountSats", "orderId", "execute"].includes(key)) throw new Error(`unknown argument: ${key}`);
  }
  if (!ACTIONS.includes(args.action)) throw new Error("action must be quote, create, finalize, or track");
  if (typeof args.invoice !== "string" || !args.invoice) throw new Error("invoice is required");
  if (!Number.isSafeInteger(args.amountSats) || args.amountSats < 1) throw new Error("amountSats must be a positive integer");
  if (args.execute !== undefined && typeof args.execute !== "boolean") throw new Error("execute must be boolean");
  if (args.orderId !== undefined && (typeof args.orderId !== "string" || !args.orderId.startsWith("ord_"))) {
    throw new Error("orderId must be a full ord_ id");
  }
  if (["finalize", "track"].includes(args.action) && !String(args.orderId || "").startsWith("ord_")) {
    throw new Error(`orderId is required for ${args.action}`);
  }
  return args;
}

export function createZeroConfServer({ driver, config = {}, gitSha = "unknown" }) {
  const secrets = secretsFrom(config);
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      sendJson(res, 200, { ok: true, git_sha: gitSha });
      return;
    }
    if (req.method !== "POST" || req.url !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    let id = null;
    try {
      const message = await readJson(req);
      id = message?.id ?? null;
      if (message?.jsonrpc !== "2.0" || typeof message?.method !== "string") {
        sendJson(res, 400, { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid JSON-RPC request" } });
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202); res.end();
        return;
      }
      if (message.method === "initialize") {
        sendJson(res, 200, { jsonrpc: "2.0", id, result: {
          protocolVersion: message.params?.protocolVersion || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "nuri-0conf", version: "0.1.0" },
        } });
        return;
      }
      if (message.method === "tools/list") {
        sendJson(res, 200, { jsonrpc: "2.0", id, result: { tools: [tool] } });
        return;
      }
      if (message.method !== "tools/call") {
        sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
        return;
      }
      let args;
      try { args = validateCall(message.params); }
      catch (error) {
        sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: redact(error.message, secrets) } });
        return;
      }
      try {
        const result = await driver[args.action]({
          invoice: args.invoice,
          amountSats: args.amountSats,
          ...(args.orderId ? { orderId: args.orderId } : {}),
          ...(["create", "finalize"].includes(args.action) ? { execute: args.execute === true } : {}),
        });
        const receipt = publicReceipt(result, secrets);
        sendJson(res, 200, { jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: JSON.stringify(receipt) }],
          structuredContent: receipt,
        } });
      } catch (error) {
        const messageText = redact(error instanceof Error ? error.message : String(error), secrets);
        sendJson(res, 200, { jsonrpc: "2.0", id, result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: messageText }) }],
        } });
      }
    } catch (error) {
      sendJson(res, 400, { jsonrpc: "2.0", id, error: { code: -32700, message: redact(error.message, secrets) } });
    }
  });
}

function sourceGitSha() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA;
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dirname(fileURLToPath(import.meta.url)), encoding: "utf8" }).trim();
}

async function start() {
  if (!process.env.CARD_CONFIG || !process.env.JOURNAL_PATH) {
    throw new Error("CARD_CONFIG and JOURNAL_PATH are required; optional HOST, PORT, and GIT_SHA");
  }
  const [{ CardLightningDriver }, { Journal }, { SwapKitV2Client }, { ProductionCardWallet }] = await Promise.all([
    import("./src/driver.js"), import("./src/journal.js"), import("./src/swapkit.js"), import("./src/card-wallet.js"),
  ]);
  const config = JSON.parse(await readFile(resolve(process.env.CARD_CONFIG), "utf8"));
  const signerV4 = String(config.signerV4Url || "https://arkade.nuri.com/v4").replace(/\/+$/, "");
  const signerOrigin = String(config.signerOriginUrl || signerV4.replace(/\/v4$/i, "")).replace(/\/+$/, "");
  Object.assign(config, {
    nodeUrl: config.nodeUrl || "https://arkade.computer",
    signerV4Url: signerV4,
    intentUrl: config.intentUrl || `${signerV4}/arkade/swap-intent/create`,
    prepareUrl: config.prepareUrl || `${signerOrigin}/api/arkade/send/prepare`,
    cosignUrl: config.cosignUrl || `${signerOrigin}/api/arkade/send/cosign`,
    completeUrl: config.completeUrl || `${signerOrigin}/api/arkade/send/complete`,
  });
  const dbPath = resolve(process.env.JOURNAL_PATH);
  const journal = new Journal(dbPath);
  const driver = new CardLightningDriver({
    config, journal, swapKit: new SwapKitV2Client({ url: config.swapKitUrl }),
    walletFactory: () => ProductionCardWallet.create(config, dirname(dbPath)),
  });
  const gitSha = sourceGitSha();
  const server = createZeroConfServer({ driver, config, gitSha });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a valid TCP port");
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => console.log(`0conf MCP listening on http://${host}:${port}/mcp git_sha=${gitSha}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
