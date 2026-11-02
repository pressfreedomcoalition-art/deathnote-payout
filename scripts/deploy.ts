/**
 * Compute DeathNotePayout address + optional mainnet deploy.
 *
 *   DAO_ADDR=EQ... npx tsx scripts/deploy.ts
 *   DAO_ADDR=... DEPLOY_MNEMONIC="..." npx tsx scripts/deploy.ts --send
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  beginCell,
  toNano,
  Dictionary,
  SendMode,
} from "@ton/core";
import { TonClient, WalletContractV4, internal } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { DeathNotePayout } from "../build/deathnote_payout_DeathNotePayout";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function sha256Str(s: string): bigint {
  return BigInt(
    "0x" + createHash("sha256").update(s, "utf8").digest("hex")
  );
}

function readPubkeyHex(): string {
  const envHex = (process.env.ATTESTATION_PUBKEY_HEX || "").replace(/^0x/, "");
  if (/^[0-9a-fA-F]{64}$/.test(envHex)) return envHex.toLowerCase();
  const candidates = [
    process.env.AAC_TON_ATTESTATION_PUBKEY_PATH || "",
    "C:/git/dredd/config/ton_attestation_pubkey.hex",
    resolve(ROOT, "../config/ton_attestation_pubkey.hex"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      const h = readFileSync(p, "utf8").trim().replace(/^0x/, "");
      if (/^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
    }
  }
  throw new Error("ATTESTATION_PUBKEY_HEX or pubkey file required");
}

function zeroAddr(): Address {
  return Address.parseRaw(
    "0:0000000000000000000000000000000000000000000000000000000000000000"
  );
}

async function main() {
  const daoAddr = Address.parse(process.env.DAO_ADDR || "");
  const pubHex = readPubkeyHex();
  const attestationPubkey = BigInt("0x" + pubHex);
  const kubyshkaKey = sha256Str(process.env.KUBYSHKA_ID || "__general__");
  const profitBps = BigInt(process.env.PROFIT_BPS || "2000");
  const rotateDelaySec = BigInt(process.env.ROTATE_DELAY_SEC || "604800");
  const jettonWallet = process.env.USDT_JW
    ? Address.parse(process.env.USDT_JW)
    : zeroAddr();
  const blcWallet = process.env.BLC_JW
    ? Address.parse(process.env.BLC_JW)
    : zeroAddr();

  const emptyBal = Dictionary.empty(
    Dictionary.Keys.BigInt(257),
    Dictionary.Values.BigInt(257)
  );
  const emptyDec = Dictionary.empty(
    Dictionary.Keys.BigInt(257),
    Dictionary.Values.DictionaryValue as never
  );
  // Empty dicts: storeDict accepts empty Dictionary of any value type
  const emptyPaid = Dictionary.empty(
    Dictionary.Keys.BigInt(257),
    Dictionary.Values.Bool()
  );

  // decisions: empty map — value parser unused when empty
  const emptyDecisions = Dictionary.empty(
    Dictionary.Keys.BigInt(257),
    Dictionary.Values.Bool()
  ) as unknown as Parameters<typeof DeathNotePayout.fromInit>[10];

  const contract = await DeathNotePayout.fromInit(
    daoAddr,
    jettonWallet,
    blcWallet,
    kubyshkaKey,
    attestationPubkey,
    0n,
    0n,
    rotateDelaySec,
    emptyBal,
    0n,
    emptyDecisions,
    emptyPaid,
    profitBps,
    0n,
    0n,
    0n,
    0n,
    0n
  );

  const addr = contract.address.toString({ bounceable: true, urlSafe: true });
  const valueTon = process.env.DEPLOY_VALUE_TON || "0.5";

  const outDir = resolve(ROOT, "deploy-out");
  mkdirSync(outDir, { recursive: true });
  const meta = {
    network: "mainnet",
    daoAddr: daoAddr.toString(),
    payoutContract: addr,
    attestationPubkey: pubHex,
    kubyshkaKey: kubyshkaKey.toString(16),
    profitBps: Number(profitBps),
    rotateDelaySec: Number(rotateDelaySec),
    jettonWallet: jettonWallet.toString(),
    blcWallet: blcWallet.toString(),
    deployValueTon: valueTon,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(resolve(outDir, "deploy-meta.json"), JSON.stringify(meta, null, 2));
  console.log(JSON.stringify(meta, null, 2));
  console.log(`\nFuture SC: ${addr}`);
  console.log(`Need ≥ ${valueTon} TON on deployer, then --send with DEPLOY_MNEMONIC`);

  void emptyDec;

  if (!process.argv.includes("--send")) return;

  const mnemonic = process.env.DEPLOY_MNEMONIC;
  if (!mnemonic) throw new Error("DEPLOY_MNEMONIC required for --send");
  const words = mnemonic.trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(words);
  const client = new TonClient({
    endpoint: process.env.TON_ENDPOINT || "https://toncenter.com/api/v2/jsonRPC",
    apiKey: process.env.TON_API_KEY || undefined,
  });
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const opened = client.open(wallet);
  const deployerAddr = wallet.address.toString({ bounceable: true, urlSafe: true });
  console.log(`Deployer: ${deployerAddr}`);
  const balance = await opened.getBalance();
  console.log(`Balance: ${Number(balance) / 1e9} TON`);
  if (balance < toNano(valueTon)) {
    throw new Error(`Insufficient: need ≥ ${valueTon} TON on ${deployerAddr}`);
  }
  const seqno = await opened.getSeqno();
  await opened.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({
        to: contract.address,
        value: toNano(valueTon),
        init: contract.init,
        body: beginCell().endCell(),
        bounce: false,
      }),
    ],
  });
  console.log("Deploy tx sent.");
  writeFileSync(
    resolve(outDir, "deploy-sent.json"),
    JSON.stringify(
      { ...meta, deployerAddr, seqno, sentAt: new Date().toISOString() },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
