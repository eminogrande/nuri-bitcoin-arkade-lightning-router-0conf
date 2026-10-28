import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const STATES = [
    "quoted",
    "funded",
    "settling",
    "claiming",
    "completed",
    "settlement_unknown",
    "refund_pending",
    "refunded",
    "manual_review",
];

const PATCH_COLUMNS = new Set([
    "preimage",
    "ark_txid",
    "signed_checkpoint_txs_json",
    "last_error",
]);

function rowToSwap(row) {
    if (!row) return null;
    return {
        ...row,
        terms: JSON.parse(row.terms_json),
        claimPlan: JSON.parse(row.claim_plan_json),
        signedCheckpointTxs: row.signed_checkpoint_txs_json
            ? JSON.parse(row.signed_checkpoint_txs_json)
            : null,
    };
}

export class Journal {
    constructor(path) {
        if (path !== ":memory:") {
            mkdirSync(dirname(path), { recursive: true });
        }
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = FULL");
        this.db.exec("PRAGMA foreign_keys = ON");
        this.db.exec("PRAGMA busy_timeout = 5000");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS swaps (
                payment_hash TEXT PRIMARY KEY,
                outpoint TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL CHECK (state IN (
                    'quoted', 'funded', 'settling', 'claiming', 'completed',
                    'settlement_unknown', 'refund_pending', 'refunded', 'manual_review'
                )),
                request_digest TEXT NOT NULL,
                tx_digest TEXT NOT NULL,
                invoice TEXT NOT NULL,
                invoice_digest TEXT NOT NULL,
                amount_msat TEXT NOT NULL,
                invoice_expires_at INTEGER NOT NULL,
                network TEXT NOT NULL,
                terms_json TEXT NOT NULL,
                vhtlc_address TEXT NOT NULL,
                vhtlc_pk_script TEXT NOT NULL,
                claim_plan_json TEXT NOT NULL,
                preimage TEXT,
                ark_txid TEXT,
                signed_checkpoint_txs_json TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
    }

    close() {
        this.db.close();
    }

    get(paymentHash) {
        return rowToSwap(
            this.db.prepare("SELECT * FROM swaps WHERE payment_hash = ?").get(paymentHash),
        );
    }

    getByOutpoint(outpoint) {
        return rowToSwap(this.db.prepare("SELECT * FROM swaps WHERE outpoint = ?").get(outpoint));
    }

    reserve(swap) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const existing =
                this.get(swap.paymentHash) || this.getByOutpoint(swap.outpoint);
            if (existing) {
                if (
                    existing.payment_hash === swap.paymentHash &&
                    existing.outpoint === swap.outpoint &&
                    existing.request_digest === swap.requestDigest &&
                    existing.tx_digest === swap.txDigest
                ) {
                    this.db.exec("COMMIT");
                    return { swap: existing, resumed: true };
                }
                throw new Error("conflicting outpoint or payment-hash reservation");
            }
            this.db
                .prepare(`
                    INSERT INTO swaps (
                        payment_hash, outpoint, state, request_digest, tx_digest,
                        invoice, invoice_digest, amount_msat, invoice_expires_at,
                        network, terms_json, vhtlc_address, vhtlc_pk_script, claim_plan_json
                    ) VALUES (?, ?, 'funded', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `)
                .run(
                    swap.paymentHash,
                    swap.outpoint,
                    swap.requestDigest,
                    swap.txDigest,
                    swap.invoice,
                    swap.invoiceDigest,
                    swap.amountMsat,
                    swap.invoiceExpiresAt,
                    swap.network,
                    JSON.stringify(swap.terms),
                    swap.vhtlcAddress,
                    swap.vhtlcPkScript,
                    JSON.stringify(swap.claimPlan),
                );
            const inserted = this.get(swap.paymentHash);
            this.db.exec("COMMIT");
            return { swap: inserted, resumed: false };
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    transition(paymentHash, allowedStates, nextState, patch = {}) {
        if (!STATES.includes(nextState)) {
            throw new Error(`unknown swap state ${nextState}`);
        }
        for (const key of Object.keys(patch)) {
            if (!PATCH_COLUMNS.has(key)) {
                throw new Error(`journal patch column is not allowed: ${key}`);
            }
        }
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const current = this.get(paymentHash);
            if (!current) {
                throw new Error(`swap not found: ${paymentHash}`);
            }
            if (current.state !== nextState && !allowedStates.includes(current.state)) {
                throw new Error(`invalid swap transition ${current.state} -> ${nextState}`);
            }
            const assignments = ["state = ?", "updated_at = CURRENT_TIMESTAMP"];
            const values = [nextState];
            for (const [key, value] of Object.entries(patch)) {
                assignments.push(`${key} = ?`);
                values.push(value);
            }
            values.push(paymentHash);
            this.db
                .prepare(`UPDATE swaps SET ${assignments.join(", ")} WHERE payment_hash = ?`)
                .run(...values);
            const updated = this.get(paymentHash);
            this.db.exec("COMMIT");
            return updated;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    noteError(paymentHash, allowedStates, error) {
        return this.transition(paymentHash, allowedStates, this.get(paymentHash).state, {
            last_error: error instanceof Error ? error.message : String(error),
        });
    }
}
