import { createHash } from "node:crypto";
import { decode } from "light-bolt11-decoder";

export function normalizeInvoice(value) {
  return String(value || "").trim().toLowerCase();
}

export function satsToBtc(sats) {
  if (!Number.isSafeInteger(sats) || sats < 0) throw new Error("invalid sat amount");
  const whole = Math.floor(sats / 100_000_000);
  const fraction = String(sats % 100_000_000).padStart(8, "0");
  return `${whole}.${fraction}`;
}

export function btcToSatsExact(value) {
  const raw = String(value || "");
  const match = raw.match(/^(\d+)(?:\.(\d{1,8}))?$/);
  if (!match) throw new Error(`invalid exact BTC amount: ${raw}`);
  const sats = BigInt(match[1]) * 100_000_000n + BigInt((match[2] || "").padEnd(8, "0") || "0");
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("BTC amount is too large");
  return Number(sats);
}

export function decodeMainnetInvoice(value, expectedAmountSats, nowSeconds = Date.now() / 1000) {
  const invoice = normalizeInvoice(value);
  if (!invoice.startsWith("lnbc")) {
    const prefix = invoice.match(/^(lnbcrt|lntbs|lntb|lnbc)/)?.[1] || "unknown";
    throw new Error(`INVOICE_NETWORK_MISMATCH prefix=${prefix} expected=lnbc`);
  }
  const amountSats = Number(expectedAmountSats);
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error("AMOUNT_REQUIRED: --amount-sats must be a positive safe integer");
  }
  const decoded = decode(invoice);
  const sections = Array.isArray(decoded?.sections) ? decoded.sections : [];
  const section = (name) => sections.find((item) => String(item?.name || "") === name)?.value;
  const paymentHash = String(section("payment_hash") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(paymentHash)) throw new Error("invoice payment hash missing or invalid");
  const msats = Number(section("amount"));
  if (!Number.isSafeInteger(msats) || msats <= 0 || msats % 1000 !== 0) {
    throw new Error("invoice amount must be a positive whole-sat amount");
  }
  if (msats / 1000 !== amountSats) {
    throw new Error(`INVOICE_AMOUNT_MISMATCH invoice=${msats / 1000} supplied=${amountSats}`);
  }
  const timestamp = Number(section("timestamp"));
  const taggedExpiry = Number(section("expiry") ?? section("expire_time"));
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error("invoice timestamp invalid");
  const expiresAt = Math.trunc(timestamp + (taggedExpiry > 0 ? taggedExpiry : 3600));
  if (nowSeconds >= expiresAt) throw new Error("lightning invoice has expired");
  return {
    invoice,
    invoiceSha256: createHash("sha256").update(invoice, "utf8").digest("hex"),
    paymentHash,
    amountSats,
    expiresAt,
  };
}

export function assertInvoiceStillPayable(facts, nowSeconds = Date.now() / 1000) {
  if (facts.expiresAt - nowSeconds < 60) {
    throw new Error("lightning invoice has expired or expires inside the 60-second funding margin");
  }
}

export function assertPaymentBinding(row, facts, orderId) {
  if (!row) throw new Error("payment is not journaled; run quote/create first");
  if (row.invoice !== facts.invoice || row.amountSats !== facts.amountSats) {
    throw new Error("REPLAY_BINDING_MISMATCH invoice or amount differs from the journal");
  }
  const suppliedOrder = String(orderId || "").trim();
  if (suppliedOrder && suppliedOrder !== row.orderId) {
    throw new Error(`ORDER_BINDING_MISMATCH supplied=${suppliedOrder} journaled=${row.orderId || "pending"}`);
  }
  if (suppliedOrder && !suppliedOrder.startsWith("ord_")) throw new Error("full SwapKit ord_ id required");
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
