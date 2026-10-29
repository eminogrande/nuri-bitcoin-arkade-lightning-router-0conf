import test from "node:test";
import assert from "node:assert/strict";
import { createZeroConfServer } from "../server.js";

const PAYMENT_HASH = "33".repeat(32);
const TXID = "44".repeat(32);
const ORDER_ID = "ord_synthetic_public";
const receipt = () => ({
  orderId: ORDER_ID,
  paymentHash: PAYMENT_HASH,
  preimage: null,
  fundingArkTxid: TXID,
  fundingOutpoint: { txid: TXID, vout: 0 },
  finalStatus: "READY_TO_FUND",
  providerStatus: "AWAITING_ACTION",
  explorers: { arkTx: `https://arkade.space/tx/${TXID}`, arkOutpoint: `https://arkade.space/tx/${TXID}#vout=0` },
});

async function fixture(t, driver, config = {}) {
  const server = createZeroConfServer({ driver, config, gitSha: "abc123" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  return {
    base,
    async rpc(method, params = {}) {
      const response = await fetch(`${base}/mcp`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

function fakeDriver(calls, override) {
  return Object.fromEntries(["quote", "create", "finalize", "track"].map((action) => [action, async (args) => {
    calls.push({ action, args });
    if (override) return override(action, args);
    return { ...receipt(), ...(args.execute ? {} : { dryRun: { operation: action } }) };
  }]));
}

test("initialize, catalog, health, and machine-readable receipt schema", async (t) => {
  const f = await fixture(t, fakeDriver([]));
  const initialized = await f.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result.serverInfo.name, "nuri-0conf");
  assert.equal(initialized.result.protocolVersion, "2024-11-05");
  const listed = await f.rpc("tools/list");
  assert.deepEqual(listed.result.tools.map((item) => item.name), ["0conf"]);
  assert.deepEqual(listed.result.tools[0].inputSchema.properties.action.enum, ["quote", "create", "finalize", "track"]);
  assert.equal(listed.result.tools[0].inputSchema.properties.execute.default, false);
  for (const field of ["orderId", "fundingOutpoint", "finalStatus", "preimage"]) {
    assert.ok(listed.result.tools[0].outputSchema.required.includes(field));
  }
  const health = await fetch(`${f.base}/healthz`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, git_sha: "abc123" });
});

test("create and finalize are dry by default and only execute:true arms them", async (t) => {
  const calls = [];
  const f = await fixture(t, fakeDriver(calls));
  const base = { invoice: "lnbc1synthetic", amountSats: 1000 };
  const dryCreate = await f.rpc("tools/call", { name: "0conf", arguments: { action: "create", ...base } });
  assert.equal(dryCreate.result.structuredContent.dryRun.operation, "create");
  const dryFinalize = await f.rpc("tools/call", { name: "0conf", arguments: { action: "finalize", ...base, orderId: ORDER_ID } });
  assert.equal(dryFinalize.result.structuredContent.dryRun.operation, "finalize");
  await f.rpc("tools/call", { name: "0conf", arguments: { action: "create", ...base, execute: true } });
  await f.rpc("tools/call", { name: "0conf", arguments: { action: "finalize", ...base, orderId: ORDER_ID, execute: true } });
  assert.deepEqual(calls.map((call) => call.args.execute), [false, false, true, true]);
  const rejected = await f.rpc("tools/call", { name: "0conf", arguments: { action: "create", ...base, execute: "true" } });
  assert.equal(rejected.error.code, -32602);
  assert.equal(calls.length, 4);
});

test("quote and track stay read-only and omit execute from the driver call", async (t) => {
  const calls = [];
  const f = await fixture(t, fakeDriver(calls));
  const base = { invoice: "lnbc1synthetic", amountSats: 1000 };
  await f.rpc("tools/call", { name: "0conf", arguments: { action: "quote", ...base } });
  await f.rpc("tools/call", { name: "0conf", arguments: { action: "track", ...base, orderId: ORDER_ID } });
  assert.equal("execute" in calls[0].args, false);
  assert.equal("execute" in calls[1].args, false);
});

test("card credentials never appear in success, error, catalog, or health responses", async (t) => {
  const config = {
    owner: "0xpublic",
    credId: "cred-sentinel-12345",
    cardPk33: "card-sentinel-12345",
    serverPk33: "server-sentinel-12345",
    prfScript: "/private/card-sentinel-path",
  };
  const driver = fakeDriver([], async (action) => {
    if (action === "track") throw new Error(`provider rejected ${config.credId}`);
    return {
      ...receipt(), credId: config.credId,
      quote: { echo: `do not expose ${config.credId}`, cardPk33: config.cardPk33, safe: "public quote" },
    };
  });
  const f = await fixture(t, driver, config);
  const success = await f.rpc("tools/call", { name: "0conf", arguments: { action: "quote", invoice: "lnbc1synthetic", amountSats: 1000 } });
  const error = await f.rpc("tools/call", { name: "0conf", arguments: { action: "track", invoice: "lnbc1synthetic", amountSats: 1000, orderId: ORDER_ID } });
  const catalog = await f.rpc("tools/list");
  const rejectedArgument = await f.rpc("tools/call", { name: "0conf", arguments: { action: "quote", invoice: "lnbc1synthetic", amountSats: 1000, credId: config.credId } });
  assert.equal(rejectedArgument.error.code, -32602);
  const health = await fetch(`${f.base}/healthz`).then((response) => response.text());
  const combined = JSON.stringify({ success, error, catalog, rejectedArgument, health });
  for (const secret of [config.credId, config.cardPk33, config.serverPk33, config.prfScript]) {
    assert.equal(combined.includes(secret), false);
  }
  assert.equal(success.result.structuredContent.quote.safe, "public quote");
  assert.equal(success.result.structuredContent.quote.cardPk33, "[redacted]");
  assert.equal(error.result.isError, true);
});
