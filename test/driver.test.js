import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeMainnetInvoice } from "../src/invoice.js";
import { preimageFromView } from "../src/driver.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AMOUNT, INVOICE, ORDER_ID, TXID, harness } from "./helpers.js";

test("invoice amount mismatch is refused before quote, card, or funding", async () => {
  const h = await harness();
  try {
    await assert.rejects(h.driver.quote({ invoice: INVOICE, amountSats: AMOUNT - 1 }), /INVOICE_AMOUNT_MISMATCH/);
    assert.equal(h.swapKit.quoteCalls, 0); assert.equal(h.wallet.fundCalls, 0);
  } finally { await h.cleanup(); }
});

test("quote settle mismatch is refused before order creation", async () => {
  const h = await harness(); h.swapKit.settleAmount = "0.00000999";
  try {
    await assert.rejects(h.driver.quote({ invoice: INVOICE, amountSats: AMOUNT }), /INVOICE_QUOTE_MISMATCH/);
    assert.equal(h.swapKit.commitCalls, 0); assert.equal(h.wallet.fundCalls, 0);
  } finally { await h.cleanup(); }
});

test("wrong Lightning network is rejected independently of invoice checksum", () => {
  assert.throws(() => decodeMainnetInvoice(INVOICE.replace(/^lnbc/, "lntb"), AMOUNT, 0), /INVOICE_NETWORK_MISMATCH/);
  assert.throws(() => decodeMainnetInvoice(INVOICE.replace(/^lnbc/, "lnbcrt"), AMOUNT, 0), /INVOICE_NETWORK_MISMATCH/);
});

test("dry-run create/finalize gates do not commit, sign, or fund", async () => {
  const h = await harness();
  try {
    await h.driver.quote({ invoice: INVOICE, amountSats: AMOUNT });
    const dryCreate = await h.driver.create({ invoice: INVOICE, amountSats: AMOUNT });
    assert.equal(dryCreate.dryRun.operation, "commit"); assert.equal(h.swapKit.commitCalls, 0);
    await h.driver.create({ invoice: INVOICE, amountSats: AMOUNT, execute: true });
    const dryFund = await h.driver.finalize({ ...h.args });
    assert.equal(dryFund.dryRun.operation, "fund-and-submit"); assert.equal(h.wallet.fundCalls, 0);
  } finally { await h.cleanup(); }
});

test("order and funding replay is exactly-once and evidence is unchanged", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const first = await h.driver.finalize({ ...h.args, execute: true });
    assert.equal(first.finalStatus, "COMPLETED"); assert.equal(first.orderId, ORDER_ID);
    assert.equal(first.fundingArkTxid, TXID); assert.equal(first.explorers.arkTx, `https://arkade.space/tx/${TXID}`);
    await h.driver.create({ ...h.args, execute: true });
    await h.driver.finalize({ ...h.args, execute: true });
    assert.equal(h.swapKit.commitCalls, 1); assert.equal(h.wallet.fundCalls, 1);
    assert.equal(h.swapKit.fundingSubmissions().length, 2); // idempotent evidence re-submit, never re-funding
    assert.deepEqual(h.swapKit.fundingSubmissions()[0].evidence, h.swapKit.fundingSubmissions()[1].evidence);
    await assert.rejects(h.driver.track({ ...h.args, orderId: "ord_wrong" }), /ORDER_BINDING_MISMATCH/);
  } finally { await h.cleanup(); }
});

test("crash before broadcast recovers reconcile-only and never sends again", async () => {
  const h = await harness();
  try {
    await h.prepare(); h.wallet.mode = "crash-before-broadcast";
    await assert.rejects(h.driver.finalize({ ...h.args, execute: true }), /SYNTHETIC_CRASH_BEFORE_BROADCAST/);
    assert.equal(h.wallet.fundCalls, 1);
    h.wallet.mode = "normal";
    const recovered = await h.driver.finalize({ ...h.args, execute: true });
    assert.equal(recovered.finalStatus, "FUNDING_UNKNOWN"); assert.equal(h.wallet.fundCalls, 1);
    assert.equal(h.swapKit.fundingSubmissions().length, 0);
  } finally { await h.cleanup(); }
});

test("crash after broadcast restores txid/outpoint and submits without a second send", async () => {
  const h = await harness();
  try {
    await h.prepare(); h.wallet.mode = "crash-after-broadcast";
    await assert.rejects(h.driver.finalize({ ...h.args, execute: true }), /SYNTHETIC_CRASH_AFTER_BROADCAST/);
    const crashed = h.journal.get((await import("../src/invoice.js")).decodeMainnetInvoice(INVOICE, AMOUNT, 0).paymentHash);
    assert.ok(crashed.fundingStartedAt); assert.equal(crashed.evidence, null);
    assert.equal(crashed.recovery.rfqId, "rfq-card-1"); assert.equal(crashed.sendIntentId, "intent-card-1");
    h.wallet.mode = "normal";
    const recovered = await h.driver.finalize({ ...h.args, execute: true });
    assert.equal(recovered.finalStatus, "COMPLETED"); assert.equal(recovered.fundingArkTxid, TXID);
    assert.equal(h.wallet.fundCalls, 1); assert.equal(h.swapKit.fundingSubmissions().length, 1);
  } finally { await h.cleanup(); }
});

test("returned preimage is accepted only when SHA256 matches the payment hash", () => {
  const preimage = "22".repeat(32);
  const paymentHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  assert.equal(preimageFromView({ settlement: { preimage } }, paymentHash), preimage);
  assert.throws(() => preimageFromView({ settlement: { preimage } }, "00".repeat(32)), /PREIMAGE_HASH_MISMATCH/);
});

test("solver failure is REFUND_READY, never completed; funding action stays bound", async () => {
  const h = await harness();
  try {
    await h.prepare(); await h.driver.finalize({ ...h.args, execute: true });
    const fundingAction = h.journal.get((await import("../src/invoice.js")).decodeMainnetInvoice(INVOICE, AMOUNT, 0).paymentHash).action;
    h.swapKit.statusView = {
      orderId: ORDER_ID, status: "FAILED", failure: { code: "solver_failed" },
      actions: [{ actionId: "refund-1", kind: "arkade_intents_refund", state: "ready", idempotencyKey: "refund-key", request: { rfqId: "rfq-card-1" } }],
    };
    const tracked = await h.driver.track(h.args);
    assert.equal(tracked.finalStatus, "REFUND_READY"); assert.equal(tracked.providerStatus, "FAILED");
    assert.equal(tracked.preimage, null); assert.equal(tracked.fundingArkTxid, TXID);
    const row = h.journal.get((await import("../src/invoice.js")).decodeMainnetInvoice(INVOICE, AMOUNT, 0).paymentHash);
    assert.deepEqual(row.action, fundingAction);
    h.swapKit.statusView = { orderId: ORDER_ID, status: "FAILED", actions: [] };
    assert.equal((await h.driver.track(h.args)).finalStatus, "REFUND_PENDING");
  } finally { await h.cleanup(); }
});

test("COMPLETED, FILLED, SETTLED, and rawProviderState settled map without failure", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const views = [
      { status: "COMPLETED", rawProviderState: "settled" },
      { status: "FILLED" },
      { status: "SETTLED" },
      { status: "COMPLETED", rawProviderState: { state: "settled" } },
    ];
    for (const view of views) {
      h.swapKit.statusView = { orderId: ORDER_ID, actions: [], ...view };
      const tracked = await h.driver.track(h.args);
      assert.equal(tracked.finalStatus, "COMPLETED");
      assert.equal(tracked.providerStatus, view.status);
    }
    h.swapKit.statusView = { orderId: ORDER_ID, status: "PROCESSING", actions: [] };
    assert.equal((await h.driver.track(h.args)).finalStatus, "PROCESSING");
  } finally { await h.cleanup(); }
});

test("a journaled preimage is returned only when its SHA256 matches the invoice", async () => {
  const h = await harness();
  try {
    await h.prepare();
    const paymentHash = decodeMainnetInvoice(INVOICE, AMOUNT, 0).paymentHash;
    const path = join(h.directory, "payments.sqlite");
    const data = JSON.parse(await readFile(path, "utf8"));
    data.payments[paymentHash].preimage = "00".repeat(32);
    await writeFile(path, JSON.stringify(data), "utf8");
    const tracked = await h.driver.track(h.args);
    assert.equal(tracked.preimage, null);
  } finally { await h.cleanup(); }
});
