/**
 * AAC-signed bootstrap: SetJettonWallet, SetBlcWallet, SyncRates.
 * Signs with AAC_TON_ATTESTATION_SECRET_PATH; broadcasts from deployer mnemonic.
 *
 *   npx tsx scripts/bootstrap-attested.ts           # sign + print, no send
 *   npx tsx scripts/bootstrap-attested.ts --send    # needs ≥0.25 TON on deployer
 */
import { createHash, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  beginCell,
  toNano,
  SendMode,
  external,
  storeMessage,
  internal,
  Cell,
} from "@ton/core";
import { mnemonicToPrivateKey, keyPairFromSeed, sign } from "@ton/crypto";
import { WalletContractV4, JettonMaster, TonClient } from "@ton/ton";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SC = Address.parse(
  process.env.PAYOUT_CONTRACT || "EQCh0czJ_1kKkrdQMixY88Q1F-MntByRg9bHGSPnRz4w5u0d"
);
const USDT_MASTER = Address.parse(
  "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"
);
const BLC_MASTER = Address.parse(
  "EQD_tFz9JQRVZNMgy3bzvnzei9deo9qc5NMtumG4_sx1zZRc"
);
const OP = {
  SetJettonWallet: 0x444e0031,
  SetBlcWallet: 0x444e0032,
  SyncRates: 0x444e0034,
} as const;

function loadSeed(): Buffer {
  const path =
    process.env.AAC_TON_ATTESTATION_SECRET_PATH ||
    "C:/git/dredd/config/ton_attestation_ed25519.secret";
  const hex = readFileSync(path, "utf8").trim();
  const seed = Buffer.from(hex, "hex");
  if (seed.length !== 32) throw new Error("bad attestation seed");
  return seed;
}

function signHash(hash: Buffer): Buffer {
  const seed = loadSeed();
  try {
    const kp = keyPairFromSeed(seed);
    return Buffer.from(sign(hash, kp.secretKey));
  } finally {
    seed.fill(0);
  }
}

function attestWallet(op: number, wallet: Address, expiresAt: number): Buffer {
  const cell = beginCell()
    .storeUint(op, 32)
    .storeAddress(wallet)
    .storeUint(expiresAt, 32)
    .endCell();
  return signHash(Buffer.from(cell.hash()));
}

function attestRates(tonUsd6: bigint, blcUsd6: bigint, expiresAt: number): Buffer {
  const cell = beginCell()
    .storeUint(OP.SyncRates, 32)
    .storeUint(tonUsd6, 64)
    .storeUint(blcUsd6, 64)
    .storeUint(expiresAt, 32)
    .endCell();
  return signHash(Buffer.from(cell.hash()));
}

function msgSetWallet(op: number, wallet: Address, expiresAt: number, sig: Buffer) {
  return beginCell()
    .storeUint(op, 32)
    .storeUint(0, 64) // queryId
    .storeAddress(wallet)
    .storeUint(expiresAt, 32)
    .storeBuffer(sig)
    .endCell();
}

function msgSyncRates(
  tonUsd6: bigint,
  blcUsd6: bigint,
  expiresAt: number,
  sig: Buffer
) {
  return beginCell()
    .storeUint(OP.SyncRates, 32)
    .storeUint(0, 64)
    .storeUint(tonUsd6, 64)
    .storeUint(blcUsd6, 64)
    .storeUint(expiresAt, 32)
    .storeBuffer(sig)
    .endCell();
}

async function tonapiGet(path: string) {
  const r = await fetch(`https://tonapi.io/v2${path}`);
  if (!r.ok) throw new Error(`tonapi ${path}: ${r.status}`);
  return r.json();
}

async function tonapiSendBoc(bocB64: string) {
  const r = await fetch("https://tonapi.io/v2/blockchain/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boc: bocB64 }),
  });
  if (!r.ok) throw new Error(`send: ${r.status} ${await r.text()}`);
}

async function main() {
  const client = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
  });
  // Derive JW without network call when possible via JettonMaster helper
  const usdt = client.open(JettonMaster.create(USDT_MASTER));
  const blc = client.open(JettonMaster.create(BLC_MASTER));
  let usdtJw: Address;
  let blcJw: Address;
  try {
    usdtJw = await usdt.getWalletAddress(SC);
    blcJw = await blc.getWalletAddress(SC);
  } catch {
    // toncenter 429 — use tonapi jetton wallets list
    const jw = await tonapiGet(
      `/accounts/${SC.toRawString()}/jettons`
    );
    throw new Error(
      `JettonMaster get failed; SC jettons=${JSON.stringify(jw).slice(0, 200)}. Fund RPC or retry.`
    );
  }

  const rates = await tonapiGet("/rates?tokens=ton&currencies=usd");
  const tonUsd = Number(rates?.rates?.TON?.prices?.USD || 0);
  // micro-USD per 1 whole TON (1e9 nano): tonUsd * 1e6
  const tonUsd6 = BigInt(Math.round(tonUsd * 1_000_000));
  // BLC: try tonapi custom; fallback last-known-ish via env
  let blcUsd6 = BigInt(process.env.BLC_USD6 || "0");
  if (blcUsd6 === 0n) {
    try {
      const br = await tonapiGet(
        `/rates?tokens=${BLC_MASTER.toRawString()}&currencies=usd`
      );
      const p = Number(
        br?.rates?.[BLC_MASTER.toRawString()]?.prices?.USD ||
          br?.rates?.BLC?.prices?.USD ||
          0
      );
      if (p > 0) blcUsd6 = BigInt(Math.round(p * 1_000_000));
    } catch {
      /* leave 0 — SyncRates can set ton only */
    }
  }

  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const sigUsdt = attestWallet(OP.SetJettonWallet, usdtJw, expiresAt);
  const sigBlc = attestWallet(OP.SetBlcWallet, blcJw, expiresAt);
  const sigRates = attestRates(tonUsd6, blcUsd6, expiresAt);

  const bodies = [
    { name: "SetJettonWallet", cell: msgSetWallet(OP.SetJettonWallet, usdtJw, expiresAt, sigUsdt) },
    { name: "SetBlcWallet", cell: msgSetWallet(OP.SetBlcWallet, blcJw, expiresAt, sigBlc) },
    { name: "SyncRates", cell: msgSyncRates(tonUsd6, blcUsd6, expiresAt, sigRates) },
  ];

  const out = {
    payoutContract: SC.toString({ bounceable: true, urlSafe: true }),
    usdtJw: usdtJw.toString({ bounceable: true, urlSafe: true }),
    blcJw: blcJw.toString({ bounceable: true, urlSafe: true }),
    tonUsd6: tonUsd6.toString(),
    blcUsd6: blcUsd6.toString(),
    expiresAt,
  };
  writeFileSync(
    resolve(ROOT, "deploy-out/bootstrap-plan.json"),
    JSON.stringify(out, null, 2)
  );
  console.log(JSON.stringify(out, null, 2));

  if (!process.argv.includes("--send")) {
    console.log("Dry-run OK. Re-run with --send when deployer has ≥0.25 TON.");
    return;
  }

  const mnemonicPath = resolve(ROOT, "deploy-out/deployer.mnemonic");
  if (!existsSync(mnemonicPath)) throw new Error("no deployer mnemonic");
  const words = readFileSync(mnemonicPath, "utf8").trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const raw = wallet.address.toRawString();
  const acc = await tonapiGet(`/accounts/${raw}`);
  if (BigInt(acc.balance) < toNano("0.2")) {
    throw new Error(
      `Fund deployer ${wallet.address.toString({ bounceable: false, urlSafe: true })} with ≥0.25 TON`
    );
  }
  const seqRes = await fetch(
    `https://tonapi.io/v2/blockchain/accounts/${raw}/methods/seqno`,
    { method: "POST" }
  );
  let seqno = Number(((await seqRes.json()) as { stack?: { num?: string }[] }).stack?.[0]?.num ?? "0");

  for (const b of bodies) {
    const transfer = wallet.createTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [
        internal({
          to: SC,
          value: toNano("0.08"),
          body: b.cell,
          bounce: true,
        }),
      ],
    });
    const ext = external({ to: wallet.address, body: transfer });
    const boc = beginCell().store(storeMessage(ext)).endCell();
    console.log(`Sending ${b.name} seqno=${seqno}…`);
    await tonapiSendBoc(boc.toBoc().toString("base64"));
    seqno += 1;
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log("Bootstrap txs sent. Verify getters.");
  void createHash;
  void Cell;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
