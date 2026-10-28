import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const JSON_FIELDS = new Set(["request", "quote", "option", "recovery", "view", "action", "evidence", "completion"]);
const COLUMNS = {
  invoice: "invoice", invoiceSha256: "invoice_sha256", amountSats: "amount_sats", owner: "owner",
  request: "request_json", quote: "quote_json", option: "option_json", idempotencyKey: "idempotency_key",
  recoveryKey: "recovery_key", recovery: "recovery_json", orderId: "order_id", view: "view_json",
  action: "action_json", sendIntentId: "send_intent_id", fundingTxid: "funding_txid",
  evidence: "evidence_json", completion: "completion_json", preimage: "preimage", status: "status",
};

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function json(value) { return value == null ? null : canonical(value); }
function parseRow(row) {
  if (!row) return null;
  const out = {};
  for (const [field, column] of Object.entries(COLUMNS)) {
    const value = row[column];
    out[field] = JSON_FIELDS.has(field) && value != null ? JSON.parse(value) : value ?? null;
  }
  out.paymentHash = row.payment_hash;
  out.fundingStartedAt = row.funding_started_at ?? null;
  out.createdAt = row.created_at;
  out.updatedAt = row.updated_at;
  return out;
}

export class Journal {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS payments (
      payment_hash TEXT PRIMARY KEY, invoice TEXT NOT NULL, invoice_sha256 TEXT NOT NULL,
      amount_sats INTEGER NOT NULL, owner TEXT NOT NULL, request_json TEXT, quote_json TEXT,
      option_json TEXT, idempotency_key TEXT UNIQUE, recovery_key TEXT, recovery_json TEXT,
      order_id TEXT UNIQUE, view_json TEXT, action_json TEXT, send_intent_id TEXT,
      funding_started_at INTEGER, funding_txid TEXT, evidence_json TEXT, completion_json TEXT,
      preimage TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
  }

  get(paymentHash) { return parseRow(this.db.prepare("SELECT * FROM payments WHERE payment_hash=?").get(paymentHash)); }
  close() { this.db.close(); }

  #assertBinding(existing, changes) {
    if (!existing) return;
    for (const field of ["invoice", "amountSats", "owner", "request", "idempotencyKey", "recoveryKey", "orderId"]) {
      if (changes[field] == null || existing[field] == null) continue;
      if (json(changes[field]) !== json(existing[field])) throw new Error(`REPLAY_BINDING_MISMATCH ${field}`);
    }
    if (existing.evidence && changes.evidence && json(existing.evidence) !== json(changes.evidence)) {
      throw new Error("REPLAY_BINDING_MISMATCH funding evidence");
    }
    if (existing.fundingTxid && changes.fundingTxid && existing.fundingTxid !== changes.fundingTxid) {
      throw new Error("REPLAY_BINDING_MISMATCH funding txid");
    }
  }

  #update(paymentHash, changes) {
    const existing = this.get(paymentHash);
    if (!existing) throw new Error("payment is not journaled");
    this.#assertBinding(existing, changes);
    const fields = Object.keys(changes).filter((key) => COLUMNS[key] && changes[key] !== undefined);
    if (!fields.length) return existing;
    const assignments = fields.map((key) => `${COLUMNS[key]}=?`).join(", ");
    const values = fields.map((key) => JSON_FIELDS.has(key) ? json(changes[key]) : changes[key]);
    this.db.prepare(`UPDATE payments SET ${assignments}, updated_at=? WHERE payment_hash=?`)
      .run(...values, Date.now(), paymentHash);
    return this.get(paymentHash);
  }

  saveQuote(data) {
    const existing = this.get(data.paymentHash);
    if (existing) {
      this.#assertBinding(existing, data);
      if (existing.orderId) return existing;
      return this.#update(data.paymentHash, data);
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO payments (
      payment_hash,invoice,invoice_sha256,amount_sats,owner,request_json,quote_json,option_json,
      idempotency_key,recovery_key,recovery_json,status,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      data.paymentHash, data.invoice, data.invoiceSha256, data.amountSats, data.owner,
      json(data.request), json(data.quote), json(data.option), data.idempotencyKey,
      data.recoveryKey, json(data.recovery), data.status || "QUOTED", now, now,
    );
    return this.get(data.paymentHash);
  }

  beginCommit(paymentHash) { return this.#update(paymentHash, { status: "COMMITTING" }); }
  saveCreated(paymentHash, data) { return this.#update(paymentHash, { ...data, status: "READY_TO_FUND" }); }
  saveSendIntent(paymentHash, sendIntentId) { return this.#update(paymentHash, { sendIntentId }); }

  claimFunding(paymentHash) {
    const result = this.db.prepare(`UPDATE payments SET funding_started_at=?,status='FUNDING_STARTED',updated_at=?
      WHERE payment_hash=? AND funding_started_at IS NULL AND evidence_json IS NULL AND order_id IS NOT NULL`)
      .run(Date.now(), Date.now(), paymentHash);
    return Number(result.changes) === 1;
  }

  saveFundingTxid(paymentHash, fundingTxid) { return this.#update(paymentHash, { fundingTxid, status: "FUNDED_UNREPORTED" }); }
  saveEvidence(paymentHash, evidence) { return this.#update(paymentHash, { evidence, status: "EVIDENCE_JOURNALED" }); }
  saveCompletion(paymentHash, completion) { return this.#update(paymentHash, { completion }); }
  saveView(paymentHash, view, action, status, preimage = null) {
    const existing = this.get(paymentHash);
    // Evidence replays always use the ORIGINAL funding action id/key. A later
    // status view may contain no actions or a new refund action; neither may
    // replace the funding submission binding.
    return this.#update(paymentHash, { view, action: existing.evidence ? existing.action : action, status, preimage: preimage || existing.preimage });
  }
  markStatus(paymentHash, status) { return this.#update(paymentHash, { status }); }
}
