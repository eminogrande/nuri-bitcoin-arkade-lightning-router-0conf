#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CardLightningDriver } from "./src/driver.js";
import { Journal } from "./src/journal.js";
import { SwapKitV2Client } from "./src/swapkit.js";
import { ProductionCardWallet } from "./src/card-wallet.js";

function parseArgs(argv) {
  const command = argv[0];
  if (!["quote", "create", "finalize", "track"].includes(command)) {
    throw new Error("usage: cli.js quote|create|finalize|track --config card.json --db payments.sqlite --invoice lnbc... --amount-sats N [--order-id ord_...] [--execute]");
  }
  const args = { command, execute: false };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--execute") { args.execute = true; continue; }
    if (!["--config", "--db", "--invoice", "--amount-sats", "--order-id"].includes(key) || !argv[i + 1]) {
      throw new Error(`unknown or incomplete argument: ${key}`);
    }
    args[{ "--config": "config", "--db": "db", "--invoice": "invoice", "--amount-sats": "amountSats", "--order-id": "orderId" }[key]] = argv[++i];
  }
  for (const key of ["config", "db", "invoice", "amountSats"]) if (!args[key]) throw new Error(`--${key} required`);
  if (["finalize", "track"].includes(command) && !args.orderId) throw new Error(`--order-id required for ${command}`);
  return args;
}

const args = parseArgs(process.argv.slice(2));
const config = JSON.parse(await readFile(resolve(args.config), "utf8"));
const signerV4 = String(config.signerV4Url || "https://arkade.nuri.com/v4").replace(/\/+$/, "");
const signerOrigin = String(config.signerOriginUrl || signerV4.replace(/\/v4$/i, "")).replace(/\/+$/, "");
Object.assign(config, {
  nodeUrl: config.nodeUrl || "https://arkade.computer",
  signerV4Url: signerV4,
  intentUrl: config.intentUrl || `${signerV4}/arkade/swap-intent/create`,
  prepareUrl: config.prepareUrl || `${signerOrigin}/api/arkade/send/prepare`,
  cosignUrl: config.cosignUrl || `${signerOrigin}/api/arkade/send/cosign`,
  completeUrl: config.completeUrl || `${signerOrigin}/api/arkade/send/complete`,
});
const dbPath = resolve(args.db);
const journal = new Journal(dbPath);
const driver = new CardLightningDriver({
  config, journal, swapKit: new SwapKitV2Client({ url: config.swapKitUrl }),
  walletFactory: () => ProductionCardWallet.create(config, dirname(dbPath)),
});
try {
  let result;
  if (args.command === "quote") result = await driver.quote(args);
  else if (args.command === "create") result = await driver.create(args);
  else if (args.command === "finalize") result = await driver.finalize(args);
  else result = await driver.track(args);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`, () => process.exit(0));
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, () => process.exit(1));
}
