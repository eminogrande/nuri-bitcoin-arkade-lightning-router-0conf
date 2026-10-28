import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const AID3 = "4E5552494D55473301";

export class CardHostBridge {
  constructor(config, journalDirectory) {
    this.config = config;
    this.journalDirectory = journalDirectory;
  }

  execJson(file, args, { input } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile(file, args, {
        timeout: 240_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NURI_MUSIG2_AID: this.config.cardAid || AID3 },
      }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`card host failed: ${stderr || error.message}`));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("card host returned non-JSON output")); }
      });
      if (input !== undefined) child.stdin.end(input);
    });
  }

  async webAuthnAssert(challenge) {
    const c = this.config;
    return this.execJson(c.python, [
      c.prfScript, "webauthn-assert", "--profile", c.credProfile,
      `--challenge-b64u=${challenge}`, "--rp-id", c.rpId, "--origin", c.origin,
      `--credential-id=${c.credId}`, "--user-verification", "required",
    ]);
  }

  async signInputSend({ msg32, inputIndex, context }) {
    await mkdir(this.journalDirectory, { recursive: true, mode: 0o700 });
    const contextFile = join(this.journalDirectory, `.cosign-${process.pid}-${randomUUID()}.json`);
    await writeFile(contextFile, JSON.stringify(context), { mode: 0o600 });
    try {
      const c = this.config;
      const result = await this.execJson(c.python, [
        c.claimSigner, "sign-input-send", "--msg32", msg32,
        "--input-index", String(inputIndex), "--cosign-url", c.cosignUrl,
        "--context-file", contextFile, "--server-pk33", c.serverPk33,
        "--client-pk33", c.cardPk33, "--expect-aggregate", context.aggregate33,
      ]);
      if (!result.final_signature_verified) throw new Error("card aggregate signature did not verify");
      return result.final_signature64;
    } finally {
      await rm(contextFile, { force: true });
    }
  }
}
