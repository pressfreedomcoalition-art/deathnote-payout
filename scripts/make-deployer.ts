/**
 * One-shot deployer wallet for SC gas. Secret mnemonic → local file only.
 *   npx tsx scripts/make-deployer.ts
 */
import { writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = resolve(ROOT, "deploy-out/deployer.mnemonic");

async function main() {
  if (existsSync(SECRET) && !process.argv.includes("--force")) {
    console.error(`Deployer mnemonic already at ${SECRET} (pass --force)`);
    process.exit(2);
  }
  mkdirSync(resolve(ROOT, "deploy-out"), { recursive: true });
  const words = await mnemonicNew(24);
  const kp = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
  writeFileSync(SECRET, words.join(" ") + "\n", { mode: 0o600 });
  try {
    chmodSync(SECRET, 0o600);
  } catch {
    /* win */
  }
  const addr = wallet.address.toString({ bounceable: true, urlSafe: true });
  writeFileSync(
    resolve(ROOT, "deploy-out/deployer.addr.txt"),
    addr + "\n",
    "utf8"
  );
  console.log(JSON.stringify({ deployer: addr, mnemonicPath: SECRET, doNotCommit: true }, null, 2));
  console.log("Fund deployer with ≥ 0.6 TON, then: npx tsx scripts/deploy-send.ts");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
