import * as btc from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import * as musig2 from "@scure/btc-signer/musig2.js";
import {
  ArkAddress, ContractManager, CSVMultisigTapscript, InMemoryContractRepository,
  InMemoryWalletRepository, MultisigTapscript, RestArkProvider, RestIndexerProvider,
  VtxoScript, Wallet, contractHandlers, provisionRefundKey, sequenceToTimelock,
  timelockToSequence,
} from "@arkade-os/sdk";
import { CardHostBridge } from "./card-host.js";
import { NuriApi } from "./nuri-api.js";

const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const bytesToHex = (bytes) => Buffer.from(bytes).toString("hex");

function appendTaprootSighash(sig64, sighashType) {
  if (sighashType === btc.SigHash.DEFAULT) return sig64;
  const out = new Uint8Array(sig64.length + 1);
  out.set(sig64, 0); out[sig64.length] = Number(sighashType) & 0xff;
  return out;
}

function scriptContainsXOnly(ops, xonly) {
  return ops.some((op) => op instanceof Uint8Array &&
    ((op.length === 32 && bytesToHex(op) === xonly) ||
     (op.length === 33 && bytesToHex(op.slice(1)) === xonly)));
}

// Same signing surface as scripts/card-arkade-claim.mjs CardBackedAggregateIdentity.
export class CardBackedAggregateIdentity {
  constructor({ cardPk33, serverPk33, approve, cardSign }) {
    this.clientPk33 = hexToBytes(cardPk33);
    this.serverPk33 = hexToBytes(serverPk33);
    this.sortedKeys = musig2.sortKeys([this.clientPk33, this.serverPk33]);
    this.aggregatedPk33 = musig2.keyAggregate(this.sortedKeys).aggPublicKey.toBytes(true);
    this.aggregatedXonly = this.aggregatedPk33.slice(1);
    this.aggregate33 = bytesToHex(this.aggregatedPk33);
    this.approve = approve;
    this.cardSign = cardSign;
  }
  async compressedPublicKey() { return this.aggregatedPk33; }
  async xOnlyPublicKey() { return this.aggregatedXonly; }
  signerSession() { throw new Error("signerSession is not supported by the card host"); }
  async signMessage() { throw new Error("signMessage is not supported by the card host"); }

  async sign(tx, inputIndexes) {
    const copy = tx.clone();
    const targets = Array.isArray(inputIndexes) ? [...inputIndexes] : [...Array(copy.inputsLength).keys()];
    const prevScripts = [], prevAmounts = [], plan = [];
    for (let i = 0; i < copy.inputsLength; i += 1) {
      const input = copy.getInput(i);
      prevScripts.push(input?.witnessUtxo?.script || new Uint8Array());
      prevAmounts.push(input?.witnessUtxo?.amount || 0n);
    }
    for (const idx of targets) {
      const input = copy.getInput(idx);
      if (!input?.witnessUtxo) throw new Error(`input ${idx} missing witnessUtxo`);
      const script = input.witnessUtxo.script;
      if (!(script?.length === 34 && script[0] === 0x51 && script[1] === 0x20)) {
        throw new Error(`input ${idx} is not taproot`);
      }
      const sighashType = input.sighashType || btc.SigHash.DEFAULT;
      let matched = false;
      for (const leaf of Array.isArray(input.tapLeafScript) ? input.tapLeafScript : []) {
        if (!Array.isArray(leaf) || leaf.length < 2 || !(leaf[1] instanceof Uint8Array)) continue;
        const scriptWithVersion = leaf[1];
        const leafScript = scriptWithVersion.subarray(0, -1);
        const leafVersion = scriptWithVersion[scriptWithVersion.length - 1];
        let ops;
        try { ops = btc.Script.decode(leafScript); } catch { continue; }
        if (!scriptContainsXOnly(ops, bytesToHex(this.aggregatedXonly))) continue;
        const msg32 = copy.preimageWitnessV1(idx, prevScripts, sighashType, prevAmounts, undefined, leafScript, leafVersion);
        plan.push({ idx, msg32, leafScript, leafVersion, sighashType });
        matched = true; break;
      }
      if (!matched) throw new Error(`input ${idx}: no aggregate-key script leaf found`);
    }
    if (!plan.length) throw new Error("no card-signable inputs");
    const signRequests = plan.map((item) => ({
      kind: "direct", input_index: item.idx, msg32: bytesToHex(item.msg32), client_pk33: bytesToHex(this.clientPk33),
    }));
    const psbtB64 = Buffer.from(copy.toPSBT()).toString("base64");
    const session = await this.approve({ psbtB64, signRequests });
    for (const item of plan) {
      const sig64 = hexToBytes(await this.cardSign({
        msg32: bytesToHex(item.msg32), inputIndex: item.idx, session, aggregate33: this.aggregate33,
      }));
      const signature = appendTaprootSighash(sig64, item.sighashType);
      copy.updateInput(item.idx, { tapScriptSig: [[
        { pubKey: this.aggregatedXonly, leafHash: tapLeafHash(item.leafScript, item.leafVersion) }, signature,
      ]] }, true);
    }
    return copy;
  }
}

const NURI_RECOVERY_TYPE = "nuri_client_recovery_v1";
const NURI_SERVER_CSV = { type: "seconds", value: 6674432n };

function addCsv(left, right) {
  if (left?.type !== right?.type) throw new Error("Nuri recovery CSV units differ");
  return { type: left.type, value: BigInt(left.value) + BigInt(right.value) };
}

function nuriCsvSpendable(context, sequence) {
  const vtxo = context.vtxo;
  if (!vtxo) return false;
  const timelock = sequenceToTimelock(sequence);
  if (timelock.type === "blocks") {
    const height = Number(context.blockHeight);
    const created = Number(vtxo.status?.block_height ?? vtxo.status?.blockHeight);
    return Number.isFinite(height) && Number.isFinite(created) && height - created >= Number(timelock.value);
  }
  const created = Number(vtxo.status?.block_time ?? vtxo.status?.blockTime);
  return Number.isFinite(created) && Number(context.currentTime || 0) / 1000 - created >= Number(timelock.value);
}

export class NuriRecoveryVtxoScript extends VtxoScript {
  constructor(params) {
    const arkadePath = MultisigTapscript.encode({
      pubkeys: [params.aggregatePubKey, params.arkadeServerPubKey],
    }).script;
    const aggregateRecovery = CSVMultisigTapscript.encode({
      timelock: params.arkadeCsvTimelock, pubkeys: [params.aggregatePubKey],
    }).script;
    const clientRecovery = CSVMultisigTapscript.encode({
      timelock: addCsv(params.arkadeCsvTimelock, params.nuriServerCsvTimelock),
      pubkeys: [params.clientPubKey],
    }).script;
    super([arkadePath, aggregateRecovery, clientRecovery]);
    this.options = {
      ...params, pubKey: params.aggregatePubKey, serverPubKey: params.arkadeServerPubKey,
      csvTimelock: params.arkadeCsvTimelock,
    };
    this.arkadePathScript = bytesToHex(arkadePath);
    this.aggregateRecoveryScript = bytesToHex(aggregateRecovery);
    this.clientRecoveryScript = bytesToHex(clientRecovery);
  }
  forfeit() { return this.findLeaf(this.arkadePathScript); }
  exit() { return this.findLeaf(this.aggregateRecoveryScript); }
  aggregateRecovery() { return this.exit(); }
  clientRecovery() { return this.findLeaf(this.clientRecoveryScript); }
  get exitScript() { return this.aggregateRecoveryScript; }
}

export const NuriRecoveryContractHandler = {
  type: NURI_RECOVERY_TYPE,
  createScript(params) { return new NuriRecoveryVtxoScript(this.deserializeParams(params)); },
  serializeParams(params) {
    return {
      aggregatePubKey: bytesToHex(params.aggregatePubKey),
      clientPubKey: bytesToHex(params.clientPubKey),
      nuriServerPubKey: bytesToHex(params.nuriServerPubKey),
      arkadeServerPubKey: bytesToHex(params.arkadeServerPubKey),
      arkadeCsvTimelock: String(timelockToSequence(params.arkadeCsvTimelock)),
      nuriServerCsvTimelock: String(timelockToSequence(params.nuriServerCsvTimelock)),
      clientCsvTimelock: String(timelockToSequence(addCsv(params.arkadeCsvTimelock, params.nuriServerCsvTimelock))),
    };
  },
  deserializeParams(params) {
    for (const field of ["aggregatePubKey", "clientPubKey", "nuriServerPubKey", "arkadeServerPubKey", "arkadeCsvTimelock", "nuriServerCsvTimelock"]) {
      if (!params[field]) throw new Error(`Nuri recovery contract param required: ${field}`);
    }
    return {
      aggregatePubKey: hexToBytes(params.aggregatePubKey),
      clientPubKey: hexToBytes(params.clientPubKey),
      nuriServerPubKey: hexToBytes(params.nuriServerPubKey),
      arkadeServerPubKey: hexToBytes(params.arkadeServerPubKey),
      arkadeCsvTimelock: sequenceToTimelock(Number(params.arkadeCsvTimelock)),
      nuriServerCsvTimelock: sequenceToTimelock(Number(params.nuriServerCsvTimelock)),
    };
  },
  isGenericallySpendable() { return true; },
  selectPath(script, _contract, context) {
    if (context.collaborative) return { leaf: script.forfeit() };
    const aggregateSequence = timelockToSequence(script.options.arkadeCsvTimelock);
    const clientSequence = timelockToSequence(addCsv(script.options.arkadeCsvTimelock, script.options.nuriServerCsvTimelock));
    if (nuriCsvSpendable(context, clientSequence)) return { leaf: script.clientRecovery(), sequence: clientSequence };
    if (nuriCsvSpendable(context, aggregateSequence)) return { leaf: script.aggregateRecovery(), sequence: aggregateSequence };
    return null;
  },
  getAllSpendingPaths(script, _contract, context) {
    const paths = context.collaborative ? [{ leaf: script.forfeit() }] : [];
    paths.push(
      { leaf: script.aggregateRecovery(), sequence: timelockToSequence(script.options.arkadeCsvTimelock) },
      { leaf: script.clientRecovery(), sequence: timelockToSequence(addCsv(script.options.arkadeCsvTimelock, script.options.nuriServerCsvTimelock)) },
    );
    return paths;
  },
  getSpendablePaths(script, contract, context) {
    return this.getAllSpendingPaths(script, contract, context).filter((path) =>
      path.sequence ? nuriCsvSpendable(context, path.sequence) : context.collaborative);
  },
};

function buildRecoveryScripts(wallet, identity) {
  const base = {
    aggregatePubKey: identity.aggregatedXonly,
    clientPubKey: identity.clientPk33.slice(1),
    nuriServerPubKey: identity.serverPk33.slice(1),
    arkadeServerPubKey: wallet.arkServerPublicKey,
    nuriServerCsvTimelock: NURI_SERVER_CSV,
  };
  const offchainParams = { ...base, arkadeCsvTimelock: wallet.offchainTapscript?.options?.csvTimelock };
  const boardingParams = { ...base, arkadeCsvTimelock: wallet.boardingTapscript?.options?.csvTimelock };
  if (!offchainParams.arkadeCsvTimelock || !boardingParams.arkadeCsvTimelock) {
    throw new Error("Nuri recovery default CSV timelock unavailable");
  }
  const offchainScript = new NuriRecoveryVtxoScript(offchainParams);
  const boardingScript = new NuriRecoveryVtxoScript(boardingParams);
  return {
    offchainParams, boardingParams, offchainScript, boardingScript,
    offchainScriptHex: bytesToHex(offchainScript.pkScript),
    boardingScriptHex: bytesToHex(boardingScript.pkScript),
    offchainAddress: offchainScript.address(wallet.network.hrp, wallet.arkServerPublicKey).encode(),
    boardingAddress: boardingScript.address(wallet.network.hrp, wallet.arkServerPublicKey).encode(),
  };
}

function assertExpectedRecovery(config, scripts) {
  const expectedAddress = String(config.expectedArkAddress);
  const expectedScript = String(config.expectedOffchainScript).toLowerCase();
  const decoded = ArkAddress.decode(expectedAddress);
  if (decoded.encode() !== expectedAddress || bytesToHex(decoded.pkScript) !== expectedScript) {
    throw new Error("ARKADE_EXPECTED_CONFIG_MISMATCH address/script");
  }
  if (scripts.offchainAddress !== expectedAddress) {
    throw new Error(`ARKADE_ADDRESS_MISMATCH expected=${expectedAddress} actual=${scripts.offchainAddress}`);
  }
  if (scripts.offchainScriptHex !== expectedScript) {
    throw new Error(`ARKADE_OFFCHAIN_SCRIPT_MISMATCH expected=${expectedScript} actual=${scripts.offchainScriptHex}`);
  }
}

function installRecoveryWallet(wallet, identity, storage, config) {
  const scripts = buildRecoveryScripts(wallet, identity);
  assertExpectedRecovery(config, scripts);
  if (contractHandlers.has(NURI_RECOVERY_TYPE)) contractHandlers.unregister(NURI_RECOVERY_TYPE);
  contractHandlers.register(NuriRecoveryContractHandler);
  wallet._offchainTapscript = scripts.offchainScript;
  wallet._boardingTapscript = scripts.boardingScript;
  wallet.getWalletScripts = async () => [scripts.offchainScriptHex, scripts.boardingScriptHex];
  wallet.getScriptMap = async () => new Map([
    [scripts.offchainScriptHex, scripts.offchainScript], [scripts.boardingScriptHex, scripts.boardingScript],
  ]);
  wallet.initializeContractManager = async () => {
    const manager = await ContractManager.create({
      indexerProvider: wallet.indexerProvider, contractRepository: storage.contractRepository,
      walletRepository: storage.walletRepository, watcherConfig: wallet.watcherConfig,
    });
    for (const role of ["wallet_default", "wallet_boarding"]) {
      const boarding = role === "wallet_boarding";
      const script = boarding ? scripts.boardingScript : scripts.offchainScript;
      await manager.createContract({
        label: boarding ? "Nuri recovery wallet boarding" : "Nuri recovery wallet default",
        type: NURI_RECOVERY_TYPE,
        params: NuriRecoveryContractHandler.serializeParams(boarding ? scripts.boardingParams : scripts.offchainParams),
        script: boarding ? scripts.boardingScriptHex : scripts.offchainScriptHex,
        address: boarding ? scripts.boardingAddress : scripts.offchainAddress,
        state: "active", metadata: { role },
      });
    }
    return manager;
  };
  wallet._contractManager = undefined;
  wallet._contractManagerInitializing = undefined;
  return scripts;
}

class NuriSendFlow {
  constructor(config, bridge, api) {
    this.config = config; this.bridge = bridge; this.api = api;
    this.session = null; this.sendPackage = null; this.cosignDone = false;
  }
  async prepare({ psbtB64, signRequests }) {
    if (this.session) return this.session;
    if (!this.sendPackage) throw new Error("Nuri send package missing before approval");
    const fullPackage = { ...this.sendPackage, psbt_b64: psbtB64, sign_requests: signRequests };
    const prep = await this.api.prepare(fullPackage);
    const assertion = await this.bridge.webAuthnAssert(prep.challenge);
    const corePackage = { ...this.sendPackage };
    this.session = {
      challengeToken: prep.challenge_token, fullPackage, corePackage,
      assertion: {
        client_data_b64u: assertion.client_data_b64u,
        auth_data_b64u: assertion.auth_data_b64u, sig_b64u: assertion.sig_b64u,
      },
    };
    return this.session;
  }
  async sign({ msg32, inputIndex, session, aggregate33 }) {
    const first = !this.cosignDone;
    const result = await this.bridge.signInputSend({
      msg32, inputIndex,
      context: {
        challenge_token: session.challengeToken, server_pk33: this.config.serverPk33,
        client_pk33: this.config.cardPk33, aggregate33,
        send_package: first ? session.fullPackage : session.corePackage,
        assertion: first ? session.assertion : null, input_index: inputIndex,
      },
    });
    this.cosignDone = true;
    return result;
  }
}

export class ProductionCardWallet {
  constructor(config, wallet, flow, api) {
    this.config = config; this.wallet = wallet; this.flow = flow; this.api = api;
    this.indexer = wallet.indexerProvider;
  }

  static async create(config, journalDirectory) {
    for (const field of ["cardPk33", "serverPk33", "credId", "credProfile", "rpId", "origin", "python", "prfScript", "claimSigner", "expectedArkAddress", "expectedOffchainScript"]) {
      if (!config[field]) throw new Error(`card config field required: ${field}`);
    }
    if (!globalThis.EventSource) globalThis.EventSource = (await import("eventsource")).EventSource;
    const bridge = new CardHostBridge(config, journalDirectory);
    const api = new NuriApi(config, config.fetchFn);
    const flow = new NuriSendFlow(config, bridge, api);
    const identity = new CardBackedAggregateIdentity({
      cardPk33: config.cardPk33, serverPk33: config.serverPk33,
      approve: (args) => flow.prepare(args), cardSign: (args) => flow.sign(args),
    });
    const arkProvider = new RestArkProvider(config.nodeUrl);
    const arkInfo = await arkProvider.getInfo();
    if (arkInfo.network !== "bitcoin") {
      throw new Error(`ARKADE_NETWORK_MISMATCH network=${arkInfo.network || "unknown"} expected=bitcoin`);
    }
    const storage = { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() };
    const wallet = await Wallet.create({
      identity, arkProvider,
      indexerProvider: new RestIndexerProvider(config.nodeUrl),
      storage,
      settlementConfig: false,
    });
    installRecoveryWallet(wallet, identity, storage, config);
    await wallet.getContractManager();
    return new ProductionCardWallet(config, wallet, flow, api);
  }

  async refundKey() {
    const key = await provisionRefundKey(this.wallet);
    return { descriptor: key.descriptor, senderPublicKey: bytesToHex(key.pubkey), refundAddress: key.address };
  }

  async createIntent({ facts, action, rfqId }) {
    const decoded = ArkAddress.decode(action.request.to);
    action.request.fundingScriptHex = bytesToHex(decoded.pkScript);
    return this.api.createSwapIntent({ facts, action, rfqId });
  }

  async fund({ facts, action, orderId, sendIntentId }) {
    this.flow.sendPackage = {
      kind: "lightning_invoice", cred_id_b64u: this.config.credId,
      client_signer_pubkey: this.config.cardPk33, send_intent_id: sendIntentId,
      route_scope: "direct_send_session", final_recipient: facts.invoice,
      final_amount_sats: facts.amountSats, funding_address: action.request.to,
      funding_script_hex: action.request.fundingScriptHex, funding_amount_sats: action.request.amountSats,
      payment_hash: facts.paymentHash, invoice: facts.invoice,
    };
    return this.wallet.send({ address: action.request.to, amount: action.request.amountSats });
  }

  async complete({ sendIntentId, fundingTxid }) {
    if (!this.flow.session) return { status: "UNAVAILABLE_AFTER_RESTART" };
    return this.api.complete({ challengeToken: this.flow.session.challengeToken, sendIntentId, fundingTxid });
  }

  async resolveFunding({ action, fundingTxid }) {
    const script = bytesToHex(ArkAddress.decode(action.request.to).pkScript);
    const response = await this.indexer.getVtxos({ scripts: [script] });
    const candidates = (response.vtxos || []).filter((v) =>
      (!fundingTxid || String(v.txid) === fundingTxid) && Number(v.value) === Number(action.request.amountSats));
    if (candidates.length !== 1 || !Number.isSafeInteger(Number(candidates[0].vout))) return null;
    const created = candidates[0];
    return { arkTxid: String(created.txid), outpoint: { txid: String(created.txid), vout: Number(created.vout) } };
  }
}
