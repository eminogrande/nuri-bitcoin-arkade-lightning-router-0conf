import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardLightningDriver } from "../src/driver.js";
import { Journal } from "../src/journal.js";

export const INVOICE = "lnbc10u1p4873xjpp53ufjx7tcchyxpe7sp6dp0a7qkgmuehczfds5ffnc7q08jngdflvqsp5yjf275z3c78ze50kvz6wxplar7fryhpn43vgmk7m409rsrknjmzqxq9z0rgqnp4qvyndeaqzman7h898jxm98dzkm0mlrsx36s93smrur7h0azyyuxc5rzjq25carzepgd4vqsyn44jrk85ezrpju92xyrk9apw4cdjh6yrwt5jgqqqqrt49lmtcqqqqqqqqqqq86qq9qrzjqt0lme2qkp6ew0sxxupxp6vtnz270pn55szmsxp5e2z3pugthx0n9apyqr6zgqqqq8hxk2qqae4jsqyugqcqzpudz22pshjgr5dus9wctvd3jhggr0vcs9xct5daeks6fqw4ek2u36yp582mn8wfuhx6twvajhyv3e8q9qyyssq7ylyh7n428l8amedr56ezk6jyn6rfls7zxlarz5780gqnrfn8h2xnt59h989hcwkjwcnh9flt76yqmasgmjnxxpkxmwfvw9rvhrcypsp3p505k";
export const ORDER_ID = "ord_card_lightning_full";
export const TXID = "11".repeat(32);
export const AMOUNT = 1000;

const option = () => ({
  optionId: "arkade:intents", quoteId: "quote-1", depositAmount: "0.00001003", settleAmount: "0.00001000",
  requiredCapabilities: ["arkade_refund_material", "arkade_intents_fund", "arkade_intents_refund"],
});
const materialView = () => ({
  orderId: ORDER_ID, status: "AWAITING_ACTION",
  actions: [{ actionId: "material-1", kind: "arkade_refund_material", state: "ready", idempotencyKey: "material-key", request: { scope: ORDER_ID } }],
});
export const fundingView = () => ({
  orderId: ORDER_ID, status: "AWAITING_ACTION",
  publicRecovery: {
    rfqId: "rfq-card-1", refundLocktime: 1_900_000_000, lockupAddress: "ark1lockup",
    destinationAddress: "ark1mine", senderPublicKey: "ab".repeat(32), amountSats: 1003,
  },
  actions: [{ actionId: "fund-1", kind: "arkade_intents_fund", state: "ready", idempotencyKey: "fund-key", request: { to: "ark1lockup", amountSats: 1003, asset: "BTC_ARKADE" } }],
});
const completedView = () => ({ orderId: ORDER_ID, status: "COMPLETED", actions: [] });

export class FakeSwapKit {
  constructor() { this.quoteCalls = 0; this.commitCalls = 0; this.submissions = []; this.statusView = null; this.settleAmount = null; }
  async quote() { this.quoteCalls += 1; return { options: [{ ...option(), ...(this.settleAmount ? { settleAmount: this.settleAmount } : {}) }] }; }
  async commit() { this.commitCalls += 1; return materialView(); }
  async submit(orderId, action, recoveryKey, evidence) {
    this.submissions.push({ orderId, action, recoveryKey, evidence });
    return action.kind === "arkade_refund_material" ? fundingView() : completedView();
  }
  async status() { return this.statusView || completedView(); }
  fundingSubmissions() { return this.submissions.filter((item) => item.action.kind === "arkade_intents_fund"); }
}

export class FakeWallet {
  constructor() { this.mode = "normal"; this.fundCalls = 0; this.intentCalls = 0; this.completeCalls = 0; this.vtxo = null; }
  async refundKey() { return { descriptor: "tr(card)", senderPublicKey: "ab".repeat(32), refundAddress: "ark1mine" }; }
  async createIntent() { this.intentCalls += 1; return "intent-card-1"; }
  async fund() {
    this.fundCalls += 1;
    if (this.mode === "crash-before-broadcast") throw new Error("SYNTHETIC_CRASH_BEFORE_BROADCAST");
    this.vtxo = { txid: TXID, vout: 1, value: 1003 };
    if (this.mode === "crash-after-broadcast") throw new Error("SYNTHETIC_CRASH_AFTER_BROADCAST");
    return TXID;
  }
  async complete() { this.completeCalls += 1; return { ok: true, synthetic: true }; }
  async resolveFunding({ fundingTxid }) {
    if (!this.vtxo || (fundingTxid && this.vtxo.txid !== fundingTxid)) return null;
    return { arkTxid: this.vtxo.txid, outpoint: { txid: this.vtxo.txid, vout: this.vtxo.vout } };
  }
}

export async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "nuri-card-lightning-test-"));
  const journal = new Journal(join(directory, "payments.sqlite"));
  const swapKit = new FakeSwapKit();
  const wallet = new FakeWallet();
  const config = { owner: "0x1234", credId: "synthetic-cred" };
  const driver = new CardLightningDriver({
    config, journal, swapKit, walletFactory: async () => wallet,
    now: () => Date.parse("2026-08-20T00:00:00Z") / 1000,
  });
  return {
    directory, journal, swapKit, wallet, driver,
    args: { invoice: INVOICE, amountSats: AMOUNT, orderId: ORDER_ID },
    async prepare() {
      await driver.quote({ invoice: INVOICE, amountSats: AMOUNT });
      return driver.create({ invoice: INVOICE, amountSats: AMOUNT, execute: true });
    },
    async cleanup() { journal.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
