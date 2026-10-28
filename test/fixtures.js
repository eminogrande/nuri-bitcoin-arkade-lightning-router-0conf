import {
    CSVMultisigTapscript,
    SingleKey,
    VHTLC,
    networks,
} from "@arkade-os/sdk";
import { invoiceDigest } from "../src/util.js";
import {
    paymentHashForPreimage,
    preimageHashForPaymentHash,
    reconstructVhtlc,
} from "../src/vhtlc.js";

export const NOW = 1_700_000_100;
export const CREATED_AT = 1_700_000_000;
export const EXPIRY = 3600;
export const AMOUNT_SATS = 1000;
export const AMOUNT_MSAT = "1000000";

export async function makeFixture({
    preimageByte = 0x42,
    txid = "11".repeat(32),
    vout = 0,
} = {}) {
    const senderIdentity = SingleKey.fromHex("01".padStart(64, "0"));
    const receiverIdentity = SingleKey.fromHex("02".padStart(64, "0"));
    const serverIdentity = SingleKey.fromHex("03".padStart(64, "0"));
    const [sender, receiver, server] = await Promise.all(
        [senderIdentity, receiverIdentity, serverIdentity].map(async (identity) =>
            Buffer.from(await identity.xOnlyPublicKey()).toString("hex"),
        ),
    );
    const preimage = Buffer.alloc(32, preimageByte);
    const preimageHex = preimage.toString("hex");
    const paymentHash = paymentHashForPreimage(preimage);
    const terms = {
        sender,
        receiver,
        server,
        refundLocktime: "1000",
        unilateralClaimDelay: { type: "blocks", value: "100" },
        unilateralRefundDelay: { type: "blocks", value: "102" },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: "103" },
        address: "unset",
    };
    const script = new VHTLC.Script({
        sender: Buffer.from(sender, "hex"),
        receiver: Buffer.from(receiver, "hex"),
        server: Buffer.from(server, "hex"),
        preimageHash: preimageHashForPaymentHash(paymentHash),
        refundLocktime: BigInt(terms.refundLocktime),
        unilateralClaimDelay: { type: "blocks", value: 100n },
        unilateralRefundDelay: { type: "blocks", value: 102n },
        unilateralRefundWithoutReceiverDelay: { type: "blocks", value: 103n },
    });
    terms.address = script
        .address(networks.regtest.hrp, Buffer.from(server, "hex"))
        .encode();
    const binding = reconstructVhtlc(terms, paymentHash);
    const invoice = `lnbcrt1explicitunitfake${paymentHash}`;
    const request = {
        quote: {
            invoice,
            invoiceDigest: invoiceDigest(invoice),
            paymentHash,
            amountMsat: AMOUNT_MSAT,
            expiresAt: CREATED_AT + EXPIRY,
            network: "regtest",
        },
        vhtlc: terms,
        outpoint: { txid, vout },
    };
    const decoded = {
        type: "bolt11 invoice",
        valid: true,
        currency: "bcrt",
        created_at: CREATED_AT,
        expiry: EXPIRY,
        payment_hash: paymentHash,
        amount_msat: `${AMOUNT_MSAT}msat`,
    };
    const vtxo = {
        txid,
        vout,
        value: AMOUNT_SATS,
        script: binding.pkScript,
        createdAt: new Date(CREATED_AT * 1000),
        status: { confirmed: true },
        isUnrolled: false,
        isSpent: false,
        isSwept: false,
        virtualStatus: { state: "preconfirmed" },
    };
    const checkpointTapscript = CSVMultisigTapscript.encode({
        timelock: { type: "blocks", value: 100n },
        pubkeys: [Buffer.from(server, "hex")],
    }).script;
    const info = {
        network: "regtest",
        signerPubkey: server,
        checkpointTapscript: Buffer.from(checkpointTapscript).toString("hex"),
    };
    return {
        senderIdentity,
        receiverIdentity,
        serverIdentity,
        preimage,
        preimageHex,
        paymentHash,
        terms,
        binding,
        request,
        decoded,
        vtxo,
        info,
    };
}

export function completePay(fixture) {
    return {
        payment_hash: fixture.paymentHash,
        status: "complete",
        amount_msat: `${AMOUNT_MSAT}msat`,
        preimage: fixture.preimageHex,
    };
}

export function failedPay(fixture) {
    return {
        payment_hash: fixture.paymentHash,
        status: "failed",
        amount_msat: `${AMOUNT_MSAT}msat`,
    };
}

export class FakeCln {
    constructor(fixture, { behavior = "success", pays, listPaysFailures = 0 } = {}) {
        this.fixture = fixture;
        this.behavior = behavior;
        this.pays = pays || [];
        this.listPaysFailures = listPaysFailures;
        this.xpayHook = null;
        this.calls = [];
        this.xpayCalls = 0;
        this.decoded = { ...fixture.decoded };
        this.info = { network: "regtest" };
    }

    async getInfo() {
        this.calls.push("getinfo");
        return this.info;
    }

    async decode(invoice) {
        this.calls.push("decode");
        if (invoice !== this.fixture.request.quote.invoice) {
            throw new Error("fake CLN received an unexpected invoice");
        }
        return this.decoded;
    }

    async xpay(invoice, amountMsat) {
        this.calls.push("xpay");
        this.xpayCalls += 1;
        if (invoice !== this.fixture.request.quote.invoice || amountMsat !== AMOUNT_MSAT) {
            throw new Error("fake CLN xpay binding mismatch");
        }
        if (this.xpayHook) {
            await this.xpayHook({ invoice, amountMsat });
        }
        if (this.behavior === "success") {
            this.pays = [completePay(this.fixture)];
            return { status: "complete" };
        }
        if (this.behavior === "crash-after-settlement") {
            this.pays = [completePay(this.fixture)];
            throw new Error("explicit fake transport loss after settlement");
        }
        if (this.behavior === "failed") {
            this.pays = [failedPay(this.fixture)];
            throw new Error("explicit fake payment failure");
        }
        if (this.behavior === "pending") {
            this.pays = [
                {
                    payment_hash: this.fixture.paymentHash,
                    status: "pending",
                    amount_msat: `${AMOUNT_MSAT}msat`,
                },
            ];
            throw new Error("explicit fake payment timeout");
        }
        throw new Error(`unknown fake CLN behavior ${this.behavior}`);
    }

    async listPays(paymentHash) {
        this.calls.push("listpays");
        if (paymentHash !== this.fixture.paymentHash) {
            throw new Error("fake CLN listpays hash mismatch");
        }
        if (this.listPaysFailures > 0) {
            this.listPaysFailures -= 1;
            throw new Error("explicit fake listpays outage");
        }
        return this.pays;
    }
}
