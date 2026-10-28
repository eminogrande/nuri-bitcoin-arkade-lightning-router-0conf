import { VHTLC, networks } from "@arkade-os/sdk";
import {
    expectHex,
    hash160,
    integerString,
    sha256,
} from "./util.js";

export function paymentHashForPreimage(preimage) {
    if (!(preimage instanceof Uint8Array) || preimage.length !== 32) {
        throw new Error("preimage must be exactly 32 bytes");
    }
    return sha256(preimage).toString("hex");
}

export function preimageHashForPaymentHash(paymentHash) {
    const normalized = expectHex(paymentHash, 32, "payment hash");
    return hash160(Buffer.from(normalized, "hex"));
}

export function normalizeDelay(value, name) {
    if (!value || (value.type !== "blocks" && value.type !== "seconds")) {
        throw new Error(`${name}.type must be blocks or seconds`);
    }
    const normalized = {
        type: value.type,
        value: integerString(value.value, `${name}.value`),
    };
    if (normalized.type === "seconds" && BigInt(normalized.value) % 512n !== 0n) {
        throw new Error(`${name}.value must be a multiple of 512 seconds`);
    }
    return normalized;
}

export function normalizeTerms(value) {
    if (!value || typeof value !== "object") {
        throw new Error("vhtlc terms are required");
    }
    if (typeof value.address !== "string" || value.address.length === 0) {
        throw new Error("vhtlc.address is required");
    }
    return {
        sender: expectHex(value.sender, 32, "vhtlc.sender"),
        receiver: expectHex(value.receiver, 32, "vhtlc.receiver"),
        server: expectHex(value.server, 32, "vhtlc.server"),
        refundLocktime: integerString(value.refundLocktime, "vhtlc.refundLocktime"),
        unilateralClaimDelay: normalizeDelay(
            value.unilateralClaimDelay,
            "vhtlc.unilateralClaimDelay",
        ),
        unilateralRefundDelay: normalizeDelay(
            value.unilateralRefundDelay,
            "vhtlc.unilateralRefundDelay",
        ),
        unilateralRefundWithoutReceiverDelay: normalizeDelay(
            value.unilateralRefundWithoutReceiverDelay,
            "vhtlc.unilateralRefundWithoutReceiverDelay",
        ),
        address: value.address,
    };
}

export function reconstructVhtlc(value, paymentHash) {
    const terms = normalizeTerms(value);
    const preimageHash = preimageHashForPaymentHash(paymentHash);
    if (preimageHash.length !== 20) {
        throw new Error("VHTLC preimage hash must be exactly 20 bytes");
    }
    const options = {
        sender: Buffer.from(terms.sender, "hex"),
        receiver: Buffer.from(terms.receiver, "hex"),
        server: Buffer.from(terms.server, "hex"),
        preimageHash,
        refundLocktime: BigInt(terms.refundLocktime),
        unilateralClaimDelay: {
            type: terms.unilateralClaimDelay.type,
            value: BigInt(terms.unilateralClaimDelay.value),
        },
        unilateralRefundDelay: {
            type: terms.unilateralRefundDelay.type,
            value: BigInt(terms.unilateralRefundDelay.value),
        },
        unilateralRefundWithoutReceiverDelay: {
            type: terms.unilateralRefundWithoutReceiverDelay.type,
            value: BigInt(terms.unilateralRefundWithoutReceiverDelay.value),
        },
    };
    const script = new VHTLC.Script(options);
    const address = script
        .address(networks.regtest.hrp, Buffer.from(terms.server, "hex"))
        .encode();
    if (address !== terms.address) {
        throw new Error(`VHTLC address mismatch: expected ${terms.address}, derived ${address}`);
    }
    return {
        script,
        terms,
        address,
        pkScript: Buffer.from(script.pkScript).toString("hex"),
        preimageHash: Buffer.from(preimageHash).toString("hex"),
    };
}

export function verifyPreimage(preimageHex, paymentHash) {
    const normalizedPreimage = expectHex(preimageHex, 32, "preimage");
    const normalizedPaymentHash = expectHex(paymentHash, 32, "payment hash");
    const preimage = Buffer.from(normalizedPreimage, "hex");
    if (paymentHashForPreimage(preimage) !== normalizedPaymentHash) {
        throw new Error("preimage does not match the BOLT11 payment hash");
    }
    const directHash = hash160(preimage).toString("hex");
    const paymentHashDigest = preimageHashForPaymentHash(normalizedPaymentHash).toString("hex");
    if (directHash !== paymentHashDigest) {
        throw new Error("preimage does not match the VHTLC HASH160 binding");
    }
    return normalizedPreimage;
}
