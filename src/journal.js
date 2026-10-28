import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
const NILS = [
  "request", "quote", "option", "idempotencyKey", "recoveryKey", "recovery", "orderId", "view",
  "action", "sendIntentId", "fundingStartedAt", "fundingTxid", "evidence", "completion", "preimage",
];
function row(value) {
  const out = { ...value };
  for (const key of NILS) if (out[key] === undefined) out[key] = null;
  return out;
}

/** Durable JSON journal. Atomic rename protects readers; the lock makes the
 * funding claim exactly-once across processes. A crash can leave the lock and
 * block later writes: fail closed, inspect, then remove only that stale lock. */
export class Journal {
  constructor(path) {
    this.path = path;
    this.lockPath = `${path}.lock`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  close() {}
  #read() {
    if (!existsSync(this.path)) return { version: 1, payments: {} };
    const parsed = JSON.parse(readFileSync(this.path, "utf8"));
    if (parsed?.version !== 1 || !parsed.payments || typeof parsed.payments !== "object") {
      throw new Error("JOURNAL_INVALID");
    }
    return parsed;
  }
  get(paymentHash) {
    const value = this.#read().payments[paymentHash];
    return value ? row(value) : null;
  }
  #write(data) {
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, this.path);
    const dir = openSync(dirname(this.path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  #transaction(work) {
    const lock = openSync(this.lockPath, "wx", 0o600);
    try {
      const data = this.#read();
      const result = work(data);
      this.#write(data);
      return result;
    } finally {
      closeSync(lock);
      unlinkSync(this.lockPath);
    }
  }
  #assertBinding(existing, changes) {
    if (!existing) return;
    for (const field of ["invoice", "amountSats", "owner", "request", "idempotencyKey", "recoveryKey", "orderId"]) {
      if (changes[field] == null || existing[field] == null) continue;
      if (canonical(changes[field]) !== canonical(existing[field])) throw new Error(`REPLAY_BINDING_MISMATCH ${field}`);
    }
    for (const field of ["evidence", "fundingTxid"]) {
      if (existing[field] && changes[field] && canonical(existing[field]) !== canonical(changes[field])) {
        throw new Error(`REPLAY_BINDING_MISMATCH ${field}`);
      }
    }
  }
  #update(paymentHash, changes) {
    return this.#transaction((data) => {
      const existing = data.payments[paymentHash];
      if (!existing) throw new Error("payment is not journaled");
      this.#assertBinding(existing, changes);
      Object.assign(existing, changes, { updatedAt: Date.now() });
      data.payments[paymentHash] = existing;
      return row(existing);
    });
  }

  saveQuote(changes) {
    return this.#transaction((data) => {
      const existing = data.payments[changes.paymentHash];
      if (existing) {
        this.#assertBinding(existing, changes);
        if (existing.orderId) return row(existing);
        Object.assign(existing, changes, { updatedAt: Date.now() });
        return row(existing);
      }
      const now = Date.now();
      const created = row({ ...changes, status: changes.status || "QUOTED", createdAt: now, updatedAt: now });
      data.payments[changes.paymentHash] = created;
      return created;
    });
  }
  beginCommit(paymentHash) { return this.#update(paymentHash, { status: "COMMITTING" }); }
  saveCreated(paymentHash, changes) { return this.#update(paymentHash, { ...changes, status: "READY_TO_FUND" }); }
  saveSendIntent(paymentHash, sendIntentId) { return this.#update(paymentHash, { sendIntentId }); }
  claimFunding(paymentHash) {
    return this.#transaction((data) => {
      const existing = data.payments[paymentHash];
      if (!existing || existing.fundingStartedAt || existing.evidence || !existing.orderId) return false;
      Object.assign(existing, { fundingStartedAt: Date.now(), status: "FUNDING_STARTED", updatedAt: Date.now() });
      return true;
    });
  }
  saveFundingTxid(paymentHash, fundingTxid) { return this.#update(paymentHash, { fundingTxid, status: "FUNDED_UNREPORTED" }); }
  saveEvidence(paymentHash, evidence) { return this.#update(paymentHash, { evidence, status: "EVIDENCE_JOURNALED" }); }
  saveCompletion(paymentHash, completion) { return this.#update(paymentHash, { completion }); }
  saveView(paymentHash, view, action, status, preimage = null) {
    const existing = this.get(paymentHash);
    return this.#update(paymentHash, {
      view, action: existing.evidence ? existing.action : action, status, preimage: preimage || existing.preimage,
    });
  }
  markStatus(paymentHash, status) { return this.#update(paymentHash, { status }); }
}
