import { createHash } from "node:crypto";

export function sha256(value) {
    return createHash("sha256").update(value).digest();
}

export function hash160(value) {
    return createHash("ripemd160").update(sha256(value)).digest();
}

export function expectHex(value, byteLength, name) {
    if (
        typeof value !== "string" ||
        value.length !== byteLength * 2 ||
        !/^[0-9a-fA-F]+$/.test(value)
    ) {
        throw new Error(`${name} must be exactly ${byteLength} bytes of hex`);
    }
    return value.toLowerCase();
}

export function expectVariableHex(value, name) {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length % 2 !== 0 ||
        !/^[0-9a-fA-F]+$/.test(value)
    ) {
        throw new Error(`${name} must be non-empty even-length hex`);
    }
    return value.toLowerCase();
}

export function integerString(value, name, { positive = true } = {}) {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
        throw new Error(`${name} must be a safe integer`);
    }
    if (typeof value === "bigint") {
        value = value.toString();
    }
    if (typeof value !== "string" && typeof value !== "number") {
        throw new Error(`${name} must be an integer`);
    }
    const normalized = String(value);
    if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
        throw new Error(`${name} must be a non-negative integer`);
    }
    if (positive && normalized === "0") {
        throw new Error(`${name} must be greater than zero`);
    }
    return normalized;
}

export function unixSeconds(value, name) {
    const normalized = integerString(value, name);
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`${name} exceeds the supported unix timestamp range`);
    }
    return parsed;
}

export function parseMsat(value, name = "amount_msat") {
    if (typeof value === "string" && value.endsWith("msat")) {
        value = value.slice(0, -4);
    }
    return integerString(value, name, { positive: false });
}

export function normalizeOutpoint(value) {
    if (!value || typeof value !== "object") {
        throw new Error("outpoint is required");
    }
    const txid = expectHex(value.txid, 32, "outpoint.txid");
    if (!Number.isInteger(value.vout) || value.vout < 0) {
        throw new Error("outpoint.vout must be a non-negative integer");
    }
    return { txid, vout: value.vout };
}

export function outpointKey(value) {
    return `${value.txid}:${value.vout}`;
}

export function invoiceDigest(invoice) {
    if (
        typeof invoice !== "string" ||
        invoice.length === 0 ||
        invoice !== invoice.trim()
    ) {
        throw new Error("quote.invoice must be a non-empty string without surrounding whitespace");
    }
    return sha256(Buffer.from(invoice, "utf8")).toString("hex");
}

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }
    if (value && typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value).sort()) {
            if (value[key] === undefined) {
                throw new Error("canonical JSON cannot contain undefined");
            }
            result[key] = canonicalize(value[key]);
        }
        return result;
    }
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
        throw new Error(`canonical JSON cannot contain ${typeof value}`);
    }
    return value;
}

export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}

export function digestJson(value) {
    return sha256(Buffer.from(canonicalJson(value), "utf8")).toString("hex");
}
