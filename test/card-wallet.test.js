import test from "node:test";
import assert from "node:assert/strict";
import {
  ArkAddress, ContractManager, DefaultVtxo, RestArkProvider, Wallet,
  contractHandlers, gatedContracts, gateExclusion,
} from "@arkade-os/sdk";
import { ProductionCardWallet, NuriSendFlow } from "../src/card-wallet.js";

const EXPECTED_ADDRESS = "ark1qzpq904am6clw3pgqwyh4p02708fy4xs0hcpwt7rwfdttuxsjameepfv6ed2mgaw4k2tdts49m4wkk3zqyrjv44sr2gcgxrm47gy7sqnlyjr3x";
const EXPECTED_SCRIPT = "5120852cd65aada3aead94b6ae152eeaeb5a2201072656b01a9184187baf904f4013";
const CARD_PK33 = "02b935bfc0d6d379243205d5c110732400cc8ae82e2fe94d6384963c7c9a62cae6";
const SERVER_PK33 = "031dbb179bb996bcd6dc9c9cfccd73c649f987c10c6016650b53789056ae641e29";
const OFFCHAIN_CSV = { type: "seconds", value: 605184n };
const BOARDING_CSV = { type: "seconds", value: 7776256n };
const hex = (bytes) => Buffer.from(bytes).toString("hex");

function config() {
  return {
    cardPk33: CARD_PK33, serverPk33: SERVER_PK33,
    expectedArkAddress: EXPECTED_ADDRESS, expectedOffchainScript: EXPECTED_SCRIPT,
    credId: "synthetic-cred", credProfile: "synthetic-profile", rpId: "synthetic.invalid",
    origin: "https://synthetic.invalid", python: process.execPath,
    prfScript: "unused", claimSigner: "unused", nodeUrl: "https://synthetic.invalid",
  };
}

function mockWalletBoot(t, { offchainCsv = OFFCHAIN_CSV } = {}) {
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = class SyntheticEventSource {};
  t.after(() => {
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  });
  t.mock.method(RestArkProvider.prototype, "getInfo", async () => ({ network: "bitcoin" }));
  const contracts = [];
  const manager = { createContract: async (contract) => { contracts.push(contract); return contract; } };
  const managerCreate = t.mock.method(ContractManager, "create", async () => manager);
  let wallet;
  t.mock.method(Wallet, "create", async ({ identity }) => {
    const arkServerPublicKey = ArkAddress.decode(EXPECTED_ADDRESS).serverPubKey;
    const defaultScript = (csvTimelock) => new DefaultVtxo.Script({
      pubKey: identity.aggregatedXonly, serverPubKey: arkServerPublicKey, csvTimelock,
    });
    wallet = {
      identity, arkServerPublicKey, network: { hrp: "ark" }, indexerProvider: {},
      offchainTapscript: defaultScript(offchainCsv), boardingTapscript: defaultScript(BOARDING_CSV),
      async getAddress() { return this._offchainTapscript.address(this.network.hrp, this.arkServerPublicKey).encode(); },
      async getContractManager() {
        if (!this._contractManager) this._contractManager = await this.initializeContractManager();
        return this._contractManager;
      },
    };
    return wallet;
  });
  return { contracts, managerCreate, wallet: () => wallet };
}

test("existing 7499-sat Nuri recovery VTXO reconstructs and decodes as generically spendable", async (t) => {
  const boot = mockWalletBoot(t);
  const production = await ProductionCardWallet.create(config(), ".tmp/synthetic-card-wallet");
  const wallet = boot.wallet();
  assert.equal(production.wallet, wallet);
  assert.equal(await wallet.getAddress(), EXPECTED_ADDRESS);
  assert.equal(hex(wallet._offchainTapscript.pkScript), EXPECTED_SCRIPT);
  assert.equal(boot.managerCreate.mock.callCount(), 1);
  assert.equal(boot.contracts.length, 2);
  assert.deepEqual(await wallet.getWalletScripts(), [EXPECTED_SCRIPT, boot.contracts[1].script]);

  const contract = boot.contracts.find((item) => item.script === EXPECTED_SCRIPT);
  assert.ok(contract);
  const handler = contractHandlers.getOrThrow(contract.type);
  const decoded = handler.createScript(contract.params);
  assert.equal(hex(decoded.pkScript), EXPECTED_SCRIPT);
  assert.equal(decoded.address(wallet.network.hrp, wallet.arkServerPublicKey).encode(), EXPECTED_ADDRESS);
  assert.equal(decoded.options.arkadeCsvTimelock.value, OFFCHAIN_CSV.value);
  assert.equal(decoded.options.nuriServerCsvTimelock.value, 6674432n);
  const vtxo7499 = {
    txid: "a20b32f23b786590df92c5c823718fd1b86395cfb5c53e60ae7eae57499ff334",
    vout: 0, value: 7499n, script: EXPECTED_SCRIPT,
  };
  assert.equal(gateExclusion(gatedContracts(boot.contracts))(vtxo7499), undefined);
});

test("configured address assertion fails before contract registration", async (t) => {
  const boot = mockWalletBoot(t, { offchainCsv: { type: "seconds", value: OFFCHAIN_CSV.value + 512n } });
  await assert.rejects(
    ProductionCardWallet.create(config(), ".tmp/synthetic-card-wallet"),
    /ARKADE_ADDRESS_MISMATCH/,
  );
  assert.equal(boot.managerCreate.mock.callCount(), 0);
  assert.equal(boot.contracts.length, 0);
});

test("each follow-up cosign carries its own PSBT without replaying the assertion", async () => {
  const calls = [];
  const bridge = {
    async webAuthnAssert() { return { client_data_b64u: "client", auth_data_b64u: "auth", sig_b64u: "sig" }; },
    async signInputSend(args) { calls.push(args); return "ab".repeat(64); },
  };
  const api = { async prepare() { return { challenge: "challenge", challenge_token: "token" }; } };
  const flow = new NuriSendFlow(config(), bridge, api);
  flow.sendPackage = { kind: "lightning_invoice", send_intent_id: "intent" };
  const session = await flow.prepare({ psbtB64: "psbt-checkpoint", signRequests: [{ input_index: 0 }] });
  await flow.sign({ msg32: "00".repeat(32), inputIndex: 0, session, aggregate33: "aggregate", psbtB64: "psbt-checkpoint" });
  await flow.sign({ msg32: "11".repeat(32), inputIndex: 1, session, aggregate33: "aggregate", psbtB64: "psbt-follow-up" });
  assert.equal(calls[0].context.send_package.psbt_b64, "psbt-checkpoint");
  assert.ok(calls[0].context.assertion);
  assert.equal(calls[1].context.send_package.psbt_b64, "psbt-follow-up");
  assert.equal(calls[1].context.send_package.sign_requests, undefined);
  assert.equal(calls[1].context.assertion, null);
});
