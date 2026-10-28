import { createHash } from "node:crypto";
import {
  assertInvoiceStillPayable, assertPaymentBinding, btcToSatsExact,
  decodeMainnetInvoice, satsToBtc, sha256Hex,
} from "./invoice.js";
import { LIGHTNING_CAPABILITIES, selectLightningOption } from "./swapkit.js";

function recoveryKeyFor(credId) {
  if (!credId) throw new Error("credId is required to derive the SwapKit recovery key");
  return sha256Hex(`nuri/swapkit/recovery/v1:cred:${credId}`);
}

function readyAction(view) { return view?.actions?.find((action) => action.state === "ready") || null; }

function extractPreimage(value, paymentHash, depth = 0) {
  if (!value || typeof value !== "object" || depth > 12) return null;
  for (const [key, child] of Object.entries(value)) {
    if (/^(preimage|paymentPreimage)$/i.test(key) && typeof child === "string") {
      const normalized = child.replace(/^0x/i, "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("PREIMAGE_INVALID");
      const hash = createHash("sha256").update(Buffer.from(normalized, "hex")).digest("hex");
      if (hash !== paymentHash) throw new Error("PREIMAGE_HASH_MISMATCH");
      return normalized;
    }
    const nested = extractPreimage(child, paymentHash, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function receipt(row, facts, extra = {}) {
  const evidence = row?.evidence || null;
  const arkTxid = row?.fundingTxid || evidence?.result?.arkTxid || null;
  const outpoint = evidence?.result?.outpoint || null;
  return {
    orderId: row?.orderId || null,
    paymentHash: facts.paymentHash,
    preimage: row?.preimage || null,
    fundingArkTxid: arkTxid,
    fundingOutpoint: outpoint,
    finalStatus: row?.status || "NEW",
    providerStatus: row?.view?.status || null,
    explorers: {
      arkTx: arkTxid ? `https://arkade.space/tx/${arkTxid}` : null,
      arkOutpoint: outpoint ? `https://arkade.space/tx/${outpoint.txid}#vout=${outpoint.vout}` : null,
    },
    ...extra,
  };
}

function assertFundingBinding(view, row, facts) {
  const action = readyAction(view);
  if (!action || action.kind !== "arkade_intents_fund" || view.actions.length !== 1) {
    throw new Error("Lightning order has no single ready funding action");
  }
  const request = action.request;
  const recovery = view.publicRecovery || {};
  const amountSats = Number(request.amountSats);
  const maxSats = btcToSatsExact(row.option.depositAmount);
  if (request.asset !== "BTC_ARKADE" || !String(request.to || "").startsWith("ark1") ||
      !Number.isSafeInteger(amountSats) || amountSats < facts.amountSats || amountSats > maxSats) {
    throw new Error("FUNDING_BINDING_MISMATCH action asset/address/amount");
  }
  if (recovery.lockupAddress !== request.to || recovery.destinationAddress !== row.recovery.refundAddress ||
      recovery.senderPublicKey !== row.recovery.senderPublicKey || Number(recovery.amountSats) !== amountSats ||
      !recovery.rfqId || !Number.isSafeInteger(Number(recovery.refundLocktime)) || Number(recovery.refundLocktime) <= 0) {
    throw new Error("FUNDING_BINDING_MISMATCH public recovery");
  }
  return action;
}

export class CardLightningDriver {
  constructor({ config, journal, swapKit, walletFactory, now = () => Date.now() / 1000 }) {
    this.config = config; this.journal = journal; this.swapKit = swapKit;
    this.walletFactory = walletFactory; this.now = now; this.wallet = null;
  }
  async #getWallet() { return this.wallet ||= await this.walletFactory(); }
  #facts(invoice, amountSats, allowExpired = false) {
    return decodeMainnetInvoice(invoice, amountSats, allowExpired ? 0 : this.now());
  }
  #row(facts, orderId) {
    const row = this.journal.get(facts.paymentHash);
    assertPaymentBinding(row, facts, orderId);
    return row;
  }

  async quote({ invoice, amountSats, orderId }) {
    if (!this.config.owner) throw new Error("owner EOA address is required for the existing SwapKit account");
    const facts = this.#facts(invoice, amountSats);
    const existing = this.journal.get(facts.paymentHash);
    if (existing) {
      assertPaymentBinding(existing, facts, orderId);
      return receipt(existing, facts, { quote: existing.quote, option: existing.option });
    }
    const wallet = await this.#getWallet();
    const refund = await wallet.refundKey();
    const recoveryKey = recoveryKeyFor(this.config.credId);
    const request = {
      from: "BTC_ARKADE", to: "BTC_LN", amount: satsToBtc(facts.amountSats), side: "settle",
      owner: this.config.owner, settleTarget: facts.invoice, refundAddress: refund.refundAddress,
      capabilities: LIGHTNING_CAPABILITIES, signerClass: { arkade: "arkade-vhtlc" },
    };
    const idempotencyKey = `card:lightning:${String(this.config.owner).toLowerCase()}:${facts.paymentHash}`;
    const quote = await this.swapKit.quote(request);
    const option = selectLightningOption(quote, facts.amountSats);
    const row = this.journal.saveQuote({
      ...facts, owner: this.config.owner, request, quote, option, idempotencyKey, recoveryKey,
      recovery: refund, status: "QUOTED",
    });
    return receipt(row, facts, { quote, option });
  }

  async create({ invoice, amountSats, orderId, execute = false }) {
    const initialFacts = this.#facts(invoice, amountSats);
    const existing = this.journal.get(initialFacts.paymentHash);
    if (!existing || !existing.quote) await this.quote({ invoice, amountSats, orderId });
    const facts = this.#facts(invoice, amountSats);
    let row = this.#row(facts, orderId);
    if (row.orderId && row.action) return receipt(row, facts);
    if (!execute) return receipt(row, facts, { dryRun: { operation: "commit", request: row.request, option: row.option } });
    this.journal.beginCommit(facts.paymentHash);
    let view = await this.swapKit.commit(row.request, row.option, row.idempotencyKey, row.recoveryKey);
    if (orderId && view.orderId !== orderId) throw new Error("ORDER_BINDING_MISMATCH commit response");
    let action = readyAction(view);
    if (action?.kind === "arkade_refund_material") {
      if (action.request.scope !== view.orderId) throw new Error("refund material scope mismatch");
      view = await this.swapKit.submit(view.orderId, action, row.recoveryKey, {
        result: {
          actionId: action.actionId, senderPublicKey: row.recovery.senderPublicKey,
          walletKeyRef: `nuri-arkade-intents-v1:${view.orderId}`,
        },
      });
    }
    action = assertFundingBinding(view, row, facts);
    row = this.journal.saveCreated(facts.paymentHash, {
      orderId: view.orderId, view, action,
      recovery: {
        ...row.recovery, rfqId: view.publicRecovery.rfqId,
        refundLocktime: Number(view.publicRecovery.refundLocktime), publicRecovery: view.publicRecovery,
      },
    });
    return receipt(row, facts);
  }

  async #completeAndSubmit(row, facts) {
    const wallet = await this.#getWallet();
    if (!row.completion) {
      const completion = await wallet.complete({ sendIntentId: row.sendIntentId, fundingTxid: row.fundingTxid });
      row = this.journal.saveCompletion(facts.paymentHash, completion);
    }
    const view = await this.swapKit.submit(row.orderId, row.action, row.recoveryKey, row.evidence);
    const action = readyAction(view);
    const preimage = extractPreimage(view, facts.paymentHash);
    const status = view.status === "FAILED" ? (action?.kind === "arkade_intents_refund" ? "REFUND_READY" : "REFUND_PENDING") : view.status;
    row = this.journal.saveView(facts.paymentHash, view, action, status, preimage);
    return receipt(row, facts);
  }

  async finalize({ invoice, amountSats, orderId, execute = false }) {
    const facts = this.#facts(invoice, amountSats, true);
    let row = this.#row(facts, orderId);
    if (!row.orderId) throw new Error("no committed order; run create --execute first");
    if (row.evidence) {
      if (!execute) return receipt(row, facts, { dryRun: { operation: "submit-existing-evidence", evidence: row.evidence } });
      return this.#completeAndSubmit(row, facts);
    }
    if (row.fundingStartedAt) {
      if (!execute) return receipt(row, facts, { dryRun: { operation: "reconcile-only-no-second-funding" } });
      const wallet = await this.#getWallet();
      const found = await wallet.resolveFunding({ action: row.action, fundingTxid: row.fundingTxid });
      if (!found) {
        row = this.journal.markStatus(facts.paymentHash, "FUNDING_UNKNOWN");
        return receipt(row, facts, { warning: "No unique funding VTXO found; funding was NOT repeated" });
      }
      if (!row.fundingTxid) row = this.journal.saveFundingTxid(facts.paymentHash, found.arkTxid);
      const evidence = { txHash: found.arkTxid, result: { actionId: row.action.actionId, ...found } };
      row = this.journal.saveEvidence(facts.paymentHash, evidence);
      return this.#completeAndSubmit(row, facts);
    }
    const action = row.action || readyAction(row.view);
    if (!action || action.kind !== "arkade_intents_fund") throw new Error("order is not ready for Arkade funding");
    if (!execute) return receipt(row, facts, { dryRun: { operation: "fund-and-submit", action } });
    const wallet = await this.#getWallet();
    assertInvoiceStillPayable(facts, this.now());
    action.rfqId = row.recovery.rfqId;
    if (!row.sendIntentId) {
      const sendIntentId = await wallet.createIntent({ facts, action, rfqId: row.recovery.rfqId });
      row = this.journal.saveSendIntent(facts.paymentHash, sendIntentId);
    }
    if (!this.journal.claimFunding(facts.paymentHash)) {
      throw new Error("FUNDING_ALREADY_STARTED: refusing a concurrent or repeated wallet.send");
    }
    row = this.journal.get(facts.paymentHash);
    const txid = await wallet.fund({ facts, action, orderId, sendIntentId: row.sendIntentId });
    if (!/^[0-9a-f]{64}$/.test(String(txid))) throw new Error("wallet.send returned a non-canonical Ark txid");
    row = this.journal.saveFundingTxid(facts.paymentHash, txid);
    const found = await wallet.resolveFunding({ action, fundingTxid: txid });
    if (!found) {
      row = this.journal.markStatus(facts.paymentHash, "FUNDING_UNKNOWN");
      return receipt(row, facts, { warning: "Funding txid is durable; resolve again without re-sending" });
    }
    const evidence = { txHash: found.arkTxid, result: { actionId: action.actionId, ...found } };
    row = this.journal.saveEvidence(facts.paymentHash, evidence);
    return this.#completeAndSubmit(row, facts);
  }

  async track({ invoice, amountSats, orderId }) {
    const facts = this.#facts(invoice, amountSats, true);
    let row = this.#row(facts, orderId);
    if (!row.orderId) throw new Error("no committed order to track");
    const view = await this.swapKit.status(row.orderId, row.recoveryKey);
    const action = readyAction(view);
    const preimage = extractPreimage(view, facts.paymentHash);
    const status = view.status === "FAILED" ? (action?.kind === "arkade_intents_refund" ? "REFUND_READY" : "REFUND_PENDING") : view.status;
    row = this.journal.saveView(facts.paymentHash, view, action, status, preimage);
    return receipt(row, facts);
  }
}
