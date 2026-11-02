/**
 * Compute future DeathNotePayout address (no network / no mnemonic).
 *   DAO_ADDR=EQ... npx tsx scripts/compute-address.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Address, Dictionary, beginCell, Cell } from "@ton/core";
import { DeathNotePayout } from "../build/deathnote_payout_DeathNotePayout";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function sha256Str(s: string): bigint {
  return BigInt("0x" + createHash("sha256").update(s, "utf8").digest("hex"));
}

function readPubkeyHex(): string {
  const envHex = (process.env.ATTESTATION_PUBKEY_HEX || "").replace(/^0x/, "");
  if (/^[0-9a-fA-F]{64}$/.test(envHex)) return envHex.toLowerCase();
  for (const p of [
    process.env.AAC_TON_ATTESTATION_PUBKEY_PATH || "",
    "C:/git/dredd/config/ton_attestation_pubkey.hex",
  ].filter(Boolean)) {
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

function packStateInit(code: Cell, data: Cell): Cell {
  return beginCell()
    .storeBit(0)
    .storeBit(0)
    .storeBit(1)
    .storeRef(code)
    .storeBit(1)
    .storeRef(data)
    .storeBit(0)
    .endCell();
}

async function main() {
  const daoAddr = Address.parse(process.env.DAO_ADDR || "");
  const pubHex = readPubkeyHex();
  const emptyBal = Dictionary.empty(
    Dictionary.Keys.BigInt(257),
    Dictionary.Values.BigInt(257)
  );
  const emptyPaid = Dictionary.empty(
    Dictionary.Keys.BigInt(257),
    Dictionary.Values.Bool()
  );
  const emptyDecisions = Dictionary.empty(
    Dictionary.Keys.BigInt(257),
    Dictionary.Values.Bool()
  ) as unknown as Parameters<typeof DeathNotePayout.fromInit>[10];

  const contract = await DeathNotePayout.fromInit(
    daoAddr,
    process.env.USDT_JW ? Address.parse(process.env.USDT_JW) : zeroAddr(),
    process.env.BLC_JW ? Address.parse(process.env.BLC_JW) : zeroAddr(),
    sha256Str(process.env.KUBYSHKA_ID || "__general__"),
    BigInt("0x" + pubHex),
    0n,
    0n,
    BigInt(process.env.ROTATE_DELAY_SEC || "604800"),
    emptyBal,
    0n,
    emptyDecisions,
    emptyPaid,
    BigInt(process.env.PROFIT_BPS || "2000"),
    0n,
    0n,
    0n,
    0n,
    0n
  );

  const addr = contract.address.toString({ bounceable: true, urlSafe: true });
  const meta = {
    network: "mainnet",
    daoAddr: daoAddr.toString(),
    payoutContract: addr,
    attestationPubkey: pubHex,
    profitBps: Number(process.env.PROFIT_BPS || "2000"),
    rotateDelaySec: Number(process.env.ROTATE_DELAY_SEC || "604800"),
    deployValueTon: process.env.DEPLOY_VALUE_TON || "0.5",
    createdAt: new Date().toISOString(),
  };
  const outDir = resolve(ROOT, "deploy-out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "deploy-meta.json"), JSON.stringify(meta, null, 2));
  if (contract.init) {
    writeFileSync(
      resolve(outDir, "state-init.boc"),
      packStateInit(contract.init.code, contract.init.data).toBoc()
    );
  }
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
