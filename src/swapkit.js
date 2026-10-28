import { btcToSatsExact } from "./invoice.js";

export const LIGHTNING_CAPABILITIES = [
  "arkade_refund_material",
  "arkade_intents_fund",
  "arkade_intents_refund",
];
const SUPPORTED_ACTIONS = new Set(LIGHTNING_CAPABILITIES);

function parseEnvelope(raw) {
  try { return JSON.parse(raw); } catch {}
  const data = String(raw).split(/\r?\n/).filter((line) => line.startsWith("data:"));
  for (let i = data.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(data[i].slice(5).trim()); } catch {}
  }
  throw new Error("SwapKit returned a non-JSON response");
}

export function selectLightningOption(quote, invoiceSats) {
  const options = Array.isArray(quote?.options) ? quote.options : [];
  const option = options.find((candidate) =>
    Array.isArray(candidate?.requiredCapabilities) &&
    candidate.requiredCapabilities.every((kind) => LIGHTNING_CAPABILITIES.includes(kind)));
  if (!option) throw new Error("No compatible Lightning route is available");
  if (btcToSatsExact(option.settleAmount) !== invoiceSats) {
    throw new Error("INVOICE_QUOTE_MISMATCH: SwapKit settle amount differs from the invoice");
  }
  const depositSats = btcToSatsExact(option.depositAmount);
  if (depositSats < invoiceSats) throw new Error("quote deposit is below the invoice amount");
  if (!option.optionId) throw new Error("quote option has no optionId");
  return option;
}

export function assertOrderView(view, expectedOrderId) {
  const orderId = String(view?.orderId || "");
  if (!orderId.startsWith("ord_")) throw new Error("SwapKit response has no full ord_ order id");
  if (expectedOrderId && orderId !== expectedOrderId) throw new Error("SwapKit returned another order id");
  if (!Array.isArray(view.actions)) throw new Error("SwapKit order has no action list");
  for (const action of view.actions) {
    if (!SUPPORTED_ACTIONS.has(action?.kind)) throw new Error(`unsupported action kind: ${action?.kind}`);
    if (!action.actionId || !action.idempotencyKey) throw new Error("malformed SwapKit action");
    if (!action.request || typeof action.request !== "object") throw new Error("action request missing");
  }
  return view;
}

export class SwapKitV2Client {
  constructor({ url = "https://swapkit.nuri.com/v2/mcp", fetchFn = fetch }) {
    this.url = url;
    this.fetchFn = fetchFn;
    this.capabilities = null;
  }

  async call(name, args) {
    const response = await this.fetchFn(this.url, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = parseEnvelope(await response.text());
    if (!response.ok || envelope.error) throw new Error(envelope.error?.message || `SwapKit HTTP ${response.status}`);
    const text = envelope.result?.content?.find((part) => typeof part?.text === "string")?.text;
    if (!text) throw new Error(`SwapKit ${name} returned no text result`);
    if (envelope.result?.isError) throw new Error(text.replace(/^Error:\s*/i, ""));
    try { return JSON.parse(text); } catch { throw new Error(`SwapKit ${name} returned a non-JSON payload`); }
  }

  async requireCapabilities() {
    if (this.capabilities) return;
    const caps = await this.call("swap_capabilities", {});
    const [major, minor] = String(caps.contractVersion || "").split(".").map(Number);
    if (major !== 2 || !Number.isFinite(minor) || minor < 2) {
      throw new Error(`SwapKit contract ${caps.contractVersion} does not satisfy 2.2`);
    }
    const advertised = new Set(caps.kinds || []);
    for (const kind of LIGHTNING_CAPABILITIES) {
      if (!advertised.has(kind)) throw new Error(`SwapKit does not advertise ${kind}`);
    }
    this.capabilities = caps;
  }

  async quote(request) {
    await this.requireCapabilities();
    return this.call("swap", { ...request, mode: "quote" });
  }

  async commit(request, option, idempotencyKey, recoveryKey) {
    await this.requireCapabilities();
    const view = await this.call("swap", {
      ...request,
      mode: "commit",
      optionId: option.optionId,
      ...(option.quoteId ? { quoteId: option.quoteId } : {}),
      idempotencyKey,
      recoveryKey,
      acceptedDepositAmount: option.depositAmount,
      minimumSettleAmount: request.amount,
    });
    return assertOrderView(view);
  }

  async submit(orderId, action, recoveryKey, evidence) {
    const view = await this.call("swap_submit", {
      orderId,
      actionId: action.actionId,
      idempotencyKey: action.idempotencyKey,
      recoveryKey,
      ...evidence,
    });
    return assertOrderView(view, orderId);
  }

  async status(orderId, recoveryKey) {
    const view = await this.call("swap_status", { orderId, recoveryKey });
    return assertOrderView(view, orderId);
  }
}
