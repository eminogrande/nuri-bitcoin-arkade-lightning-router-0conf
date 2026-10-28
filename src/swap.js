import {
    digestJson,
    expectHex,
    invoiceDigest,
    normalizeOutpoint,
    outpointKey,
    parseMsat,
    unixSeconds,
} from "./util.js";
import { normalizeTerms, verifyPreimage } from "./vhtlc.js";

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function normalizeRequest(request) {
    if (!request || typeof request !== "object") {
        throw new Error("swap request is required");
    }
    const quote = request.quote;
    if (!quote || typeof quote !== "object") {
        throw new Error("quote is required");
    }
    if (quote.network !== "regtest") {
        throw new Error("quote.network must be regtest");
    }
    const actualInvoiceDigest = invoiceDigest(quote.invoice);
    const suppliedInvoiceDigest = expectHex(
        quote.invoiceDigest,
        32,
        "quote.invoiceDigest",
    );
    if (actualInvoiceDigest !== suppliedInvoiceDigest) {
        throw new Error("invoice does not match quote.invoiceDigest");
    }
    const amountMsat = parseMsat(quote.amountMsat, "quote.amountMsat");
    if (BigInt(amountMsat) <= 0n || BigInt(amountMsat) % 1000n !== 0n) {
        throw new Error("quote.amountMsat must be a positive whole-satoshi amount");
    }
    const normalized = {
        quote: {
            invoice: quote.invoice,
            invoiceDigest: actualInvoiceDigest,
            paymentHash: expectHex(quote.paymentHash, 32, "quote.paymentHash"),
            amountMsat,
            expiresAt: unixSeconds(quote.expiresAt, "quote.expiresAt"),
            network: quote.network,
        },
        vhtlc: normalizeTerms(request.vhtlc),
        outpoint: normalizeOutpoint(request.outpoint),
    };
    normalized.requestDigest = digestJson(normalized);
    return normalized;
}

function normalizeDecodedInvoice(decoded) {
    if (decoded.valid !== true || decoded.type !== "bolt11 invoice") {
        throw new Error("CLN decode did not return a valid BOLT11 invoice");
    }
    const createdAt = unixSeconds(decoded.created_at, "decoded invoice created_at");
    const expiry = unixSeconds(decoded.expiry, "decoded invoice expiry");
    return {
        paymentHash: expectHex(decoded.payment_hash, 32, "decoded invoice payment_hash"),
        amountMsat: parseMsat(decoded.amount_msat, "decoded invoice amount_msat"),
        currency: decoded.currency,
        expiresAt: createdAt + expiry,
    };
}

export class SwapEngine {
    constructor({ journal, cln, arkade, now = () => Math.floor(Date.now() / 1000) }) {
        if (!journal || !cln || !arkade) {
            throw new Error("journal, cln, and arkade are required");
        }
        this.journal = journal;
        this.cln = cln;
        this.arkade = arkade;
        this.now = now;
    }

    async execute(request) {
        const normalized = normalizeRequest(request);
        const paymentHash = normalized.quote.paymentHash;
        const outpoint = outpointKey(normalized.outpoint);
        const existing = this.journal.get(paymentHash) || this.journal.getByOutpoint(outpoint);
        if (existing) {
            if (existing.request_digest !== normalized.requestDigest) {
                throw new Error("retry conflicts with the durable outpoint/payment-hash binding");
            }
            return this.resume(existing, normalized);
        }

        await this.arkade.assertReceiver(normalized.vhtlc);
        const clnInfo = await this.cln.getInfo();
        if (clnInfo.network !== "regtest") {
            throw new Error(`CLN network mismatch: ${clnInfo.network}`);
        }
        const decoded = normalizeDecodedInvoice(await this.cln.decode(normalized.quote.invoice));
        if (decoded.paymentHash !== paymentHash) {
            throw new Error("decoded invoice payment hash does not match the quote");
        }
        if (decoded.amountMsat !== normalized.quote.amountMsat) {
            throw new Error("decoded invoice amount does not match the quote");
        }
        if (decoded.currency !== "bcrt") {
            throw new Error(`decoded invoice network does not match regtest: ${decoded.currency}`);
        }
        if (decoded.expiresAt !== normalized.quote.expiresAt) {
            throw new Error("decoded invoice expiry does not match the quote");
        }
        if (this.now() >= decoded.expiresAt) {
            throw new Error("invoice is expired");
        }

        const prepared = await this.arkade.prepare({
            terms: normalized.vhtlc,
            paymentHash,
            amountMsat: normalized.quote.amountMsat,
            outpoint: normalized.outpoint,
        });
        const reservation = this.journal.reserve({
            paymentHash,
            outpoint,
            requestDigest: normalized.requestDigest,
            txDigest: prepared.txDigest,
            invoice: normalized.quote.invoice,
            invoiceDigest: normalized.quote.invoiceDigest,
            amountMsat: normalized.quote.amountMsat,
            invoiceExpiresAt: normalized.quote.expiresAt,
            network: normalized.quote.network,
            terms: prepared.binding.terms,
            vhtlcAddress: prepared.binding.address,
            vhtlcPkScript: prepared.binding.pkScript,
            claimPlan: prepared.plan,
        });
        if (reservation.resumed) {
            return this.resume(reservation.swap, normalized);
        }
        return this.pay(reservation.swap);
    }

    async resume(swap, normalized) {
        switch (swap.state) {
            case "completed":
            case "refund_pending":
            case "refunded":
            case "manual_review":
                return this.result(swap);
            case "funded":
                if (this.now() >= swap.invoice_expires_at) {
                    throw new Error("invoice is expired; refusing a first Lightning payment");
                }
                await this.arkade.assertReceiver(normalized.vhtlc);
                return this.pay(swap);
            case "settling":
            case "settlement_unknown":
                await this.arkade.assertReceiver(normalized.vhtlc);
                return this.reconcile(swap);
            case "claiming":
                await this.arkade.assertReceiver(normalized.vhtlc);
                return this.claim(swap);
            default:
                throw new Error(`cannot resume swap in state ${swap.state}`);
        }
    }

    result(swap, extra = {}) {
        return {
            state: swap.state,
            paymentHash: swap.payment_hash,
            outpoint: swap.outpoint,
            txDigest: swap.tx_digest,
            arkTxid: swap.ark_txid || undefined,
            lastError: swap.last_error || undefined,
            ...extra,
        };
    }

    async pay(swap) {
        if (swap.state !== "funded") {
            throw new Error(`Lightning payment may start only from funded, not ${swap.state}`);
        }
        swap = this.journal.transition(swap.payment_hash, ["funded"], "settling");
        let paymentError;
        try {
            await this.cln.xpay(swap.invoice, swap.amount_msat);
        } catch (error) {
            paymentError = error;
        }
        return this.reconcile(swap, paymentError);
    }

    async reconcile(swap, paymentError) {
        let pays;
        try {
            pays = await this.cln.listPays(swap.payment_hash);
            if (!Array.isArray(pays)) {
                throw new Error("listPays did not return an array");
            }
        } catch (error) {
            const unknown = this.journal.transition(
                swap.payment_hash,
                ["settling", "settlement_unknown"],
                "settlement_unknown",
                { last_error: errorMessage(paymentError || error) },
            );
            return this.result(unknown);
        }

        if (pays.some((pay) => expectHex(pay.payment_hash, 32, "listpays payment_hash") !== swap.payment_hash)) {
            const review = this.journal.transition(
                swap.payment_hash,
                ["settling", "settlement_unknown"],
                "manual_review",
                { last_error: "listpays returned an unrelated payment hash" },
            );
            return this.result(review);
        }
        const complete = pays.filter((pay) => pay.status === "complete");
        if (complete.length > 0) {
            if (complete.length !== 1) {
                const review = this.journal.transition(
                    swap.payment_hash,
                    ["settling", "settlement_unknown"],
                    "manual_review",
                    { last_error: "listpays returned multiple complete payments" },
                );
                return this.result(review);
            }
            try {
                const pay = complete[0];
                if (parseMsat(pay.amount_msat) !== swap.amount_msat) {
                    throw new Error("settled amount does not match the journaled invoice amount");
                }
                const preimage = verifyPreimage(
                    pay.preimage || pay.payment_preimage,
                    swap.payment_hash,
                );
                const claiming = this.journal.transition(
                    swap.payment_hash,
                    ["settling", "settlement_unknown"],
                    "claiming",
                    { preimage, last_error: null },
                );
                return this.claim(claiming);
            } catch (error) {
                const review = this.journal.transition(
                    swap.payment_hash,
                    ["settling", "settlement_unknown"],
                    "manual_review",
                    { last_error: errorMessage(error) },
                );
                return this.result(review);
            }
        }
        if (pays.length > 0 && pays.every((pay) => pay.status === "failed")) {
            const refund = this.journal.transition(
                swap.payment_hash,
                ["settling", "settlement_unknown"],
                "refund_pending",
                { last_error: errorMessage(paymentError || "Core Lightning reports payment failed") },
            );
            return this.result(refund);
        }
        const unknown = this.journal.transition(
            swap.payment_hash,
            ["settling", "settlement_unknown"],
            "settlement_unknown",
            {
                last_error: errorMessage(
                    paymentError || "Core Lightning has no definitive completed/failed result",
                ),
            },
        );
        return this.result(unknown);
    }

    async claim(swap) {
        try {
            const submission = swap.ark_txid
                ? {
                      arkTxid: swap.ark_txid,
                      signedCheckpointTxs: swap.signedCheckpointTxs,
                  }
                : null;
            const claimed = await this.arkade.claim({
                plan: swap.claimPlan,
                txDigest: swap.tx_digest,
                paymentHash: swap.payment_hash,
                preimage: swap.preimage,
                submission,
                onSubmitted: async (submitted) => {
                    this.journal.transition(
                        swap.payment_hash,
                        ["claiming"],
                        "claiming",
                        {
                            ark_txid: submitted.arkTxid,
                            signed_checkpoint_txs_json: JSON.stringify(
                                submitted.signedCheckpointTxs,
                            ),
                            last_error: null,
                        },
                    );
                },
            });
            const completed = this.journal.transition(
                swap.payment_hash,
                ["claiming"],
                "completed",
                { ark_txid: claimed.arkTxid, last_error: null },
            );
            return this.result(completed);
        } catch (error) {
            const claiming = this.journal.noteError(swap.payment_hash, ["claiming"], error);
            return this.result(claiming);
        }
    }
}

export { normalizeRequest, normalizeDecodedInvoice };
