export async function postJson(url, body, fetchFn = fetch) {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json",
      "x-arkade-client": "nuri-card-swapkit-driver", "x-arkade-sdk": "nuri-card-swapkit-driver",
    },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Nuri API returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`Nuri API HTTP ${response.status}: ${data.error || data.reason || "request failed"}`);
  return data;
}

export class NuriApi {
  constructor(config, fetchFn = fetch) { this.config = config; this.fetchFn = fetchFn; }

  async createSwapIntent({ facts, action, rfqId }) {
    const c = this.config;
    const request = action.request;
    const response = await postJson(c.intentUrl, {
      kind: "lightning_invoice", cred_id_b64u: c.credId, client_signer_pubkey: c.cardPk33,
      final_recipient: facts.invoice, final_amount_sats: facts.amountSats,
      funding_address: request.to, funding_script_hex: request.fundingScriptHex,
      funding_amount_sats: request.amountSats, payment_hash: facts.paymentHash,
      invoice: facts.invoice, provider: "arkade_intents", rfq_id: rfqId,
    }, this.fetchFn);
    const id = String(response?.intent?.id || "");
    if (!id) throw new Error("Nuri swap-intent/create returned no intent id");
    return id;
  }

  async prepare(fullPackage) {
    const response = await postJson(this.config.prepareUrl, fullPackage, this.fetchFn);
    if (!response.challenge_token || !response.challenge) throw new Error("Nuri send/prepare returned no challenge");
    return response;
  }

  async complete({ challengeToken, sendIntentId, fundingTxid }) {
    return postJson(this.config.completeUrl, {
      challenge_token: challengeToken, send_intent_id: sendIntentId, txid: fundingTxid,
    }, this.fetchFn);
  }
}
