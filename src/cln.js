import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expectHex, parseMsat } from "./util.js";

const execFileAsync = promisify(execFile);

export class ClnAdapter {
    constructor({
        cliPath = "lightning-cli",
        lightningDir,
        network = "regtest",
        timeoutMs = 120_000,
        exec = execFileAsync,
    } = {}) {
        if (network !== "regtest") {
            throw new Error("this POC only permits the regtest CLN network");
        }
        this.cliPath = cliPath;
        this.lightningDir = lightningDir;
        this.network = network;
        this.timeoutMs = timeoutMs;
        this.exec = exec;
    }

    async call(method, args = []) {
        const cliArgs = [`--network=${this.network}`];
        if (this.lightningDir) {
            cliArgs.push(`--lightning-dir=${this.lightningDir}`);
        }
        cliArgs.push(method, ...args);
        let stdout;
        try {
            ({ stdout } = await this.exec(this.cliPath, cliArgs, {
                timeout: this.timeoutMs,
                maxBuffer: 16 * 1024 * 1024,
                windowsHide: true,
            }));
        } catch (error) {
            const detail = error.stderr?.trim() || error.message;
            const wrapped = new Error(`lightning-cli ${method} failed: ${detail}`);
            wrapped.code = error.code;
            wrapped.cause = error;
            throw wrapped;
        }
        try {
            return JSON.parse(stdout);
        } catch (error) {
            throw new Error(`lightning-cli ${method} returned invalid JSON`, { cause: error });
        }
    }

    async getInfo() {
        return this.call("getinfo");
    }

    async decode(invoice) {
        return this.call("decode", [invoice]);
    }

    async xpay(invoice, amountMsat) {
        const normalizedAmount = parseMsat(amountMsat);
        if (BigInt(normalizedAmount) <= 0n) {
            throw new Error("xpay amount must be greater than zero");
        }
        return this.call("xpay", [invoice, normalizedAmount]);
    }

    async listPays(paymentHash) {
        const normalizedHash = expectHex(paymentHash, 32, "payment hash");
        const response = await this.call("listpays", [`payment_hash=${normalizedHash}`]);
        if (!response || !Array.isArray(response.pays)) {
            throw new Error("lightning-cli listpays response has no pays array");
        }
        return response.pays;
    }
}
