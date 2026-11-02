/**
 * Deploy DeathNotePayout via tonapi (avoids toncenter 429).
 * Reads mnemonic from deploy-out/deployer.mnemonic (never prints it).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Address,
  beginCell,
  toNano,
  Dictionary,
  SendMode,
  external,
  storeMessage,
  internal,
} from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { DeathNotePayout } from "../build/deathnote_payout_DeathNotePayout";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MNEMONIC_PATH = resolve(ROOT, "deploy-out/deployer.mnemonic");

function sha256Str(s: string): bigint {
  return BigInt("0x" + createHash("sha256").update(s, "utf8").digest("hex"));
}

function readPubkeyHex(): string {
  const envHex = (process.env.ATTESTATION_PUBKEY_HEX || "").replace(/^0x/, "");
  if (/^[0-9a-fA-F]{64}$/.test(envHex)) return envHex.toLowerCase();
  const p =
    process.env.AAC_TON_ATTESTATION_PUBKEY_PATH ||
    "C:/git/dredd/config/ton_attestation_pubkey.hex";
  return readFileSync(p, "utf8").trim().replace(/^0x/, "").toLowerCase();
}

function zeroAddr(): Address {
  return Address.parseRaw(
    "0:0000000000000000000000000000000000000000000000000000000000000000"
  );
}

async function tonapiGet(path: string) {
  const r = await fetch(`https://tonapi.io/v2${path}`);
  if (!r.ok) throw new Error(`tonapi GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function tonapiSendBoc(bocB64: string) {
  const r = await fetch("https://tonapi.io/v2/blockchain/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boc: bocB64 }),
  });
  if (!r.ok) throw new Error(`tonapi send: ${r.status} ${await r.text()}`);
  return r.json().catch(() => ({}));
}

async function waitActive(raw: string, label: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const acc = await tonapiGet(`/accounts/${raw}`);
    if (acc.status === "active") {
      console.log(`${label} ACTIVE`);
      return acc;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${label} not active yet`);
}

async function main() {
  if (!existsSync(MNEMONIC_PATH)) {
    throw new Error(`Missing ${MNEMONIC_PATH}`);
  }
  const dao = process.env.DAO_ADDR || "EQDxudnAwFhDLglViI1JJvnvYE38qJgNuh5XA_z0L1_gLiOR";
  const daoAddr = Address.parse(dao);
  const pubHex = readPubkeyHex();
  const valueTon = process.env.DEPLOY_VALUE_TON || "0.4";

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
    zeroAddr(),
    zeroAddr(),
    sha256Str("__general__"),
    BigInt("0x" + pubHex),
    0n,
    0n,
    604800n,
    emptyBal,
    0n,
    emptyDecisions,
    emptyPaid,
    2000n,
    0n,
    0n,
    0n,
    0n,
    0n
  );

  const words = readFileSync(MNEMONIC_PATH, "utf8").trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  const deployerRaw = wallet.address.toRawString();
  const scRaw = contract.address.toRawString();
  const deployerEq = wallet.address.toString({ bounceable: true, urlSafe: true });
  const scEq = contract.address.toString({ bounceable: true, urlSafe: true });

  const acc = await tonapiGet(`/accounts/${deployerRaw}`);
  console.log(`Deployer: ${deployerEq} status=${acc.status} bal=${Number(acc.balance) / 1e9}`);
  console.log(`SC:       ${scEq}`);
  if (BigInt(acc.balance) < toNano("0.55")) {
    throw new Error("Insufficient deployer balance");
  }

  // Already deployed?
  try {
    const scAcc = await tonapiGet(`/accounts/${scRaw}`);
    if (scAcc.status === "active") {
      console.log("SC already active:", scEq);
      return;
    }
  } catch {
    /* ok */
  }

  const needWalletInit = acc.status !== "active";
  const seqno = needWalletInit ? 0 : Number((await tonapiGet(`/wallet/${deployerRaw}`)).seqno ?? 0);

  const transfer = wallet.createTransfer({
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

  const ext = external({
    to: wallet.address,
    init: needWalletInit ? wallet.init : undefined,
    body: transfer,
  });
  const boc = beginCell().store(storeMessage(ext)).endCell();
  const bocB64 = boc.toBoc().toString("base64");

  console.log(`Sending deploy (walletInit=${needWalletInit}, seqno=${seqno}, value=${valueTon} TON)…`);
  await tonapiSendBoc(bocB64);
  console.log("Broadcast OK, waiting…");

  await waitActive(scRaw, "SC");
  writeFileSync(
    resolve(ROOT, "deploy-out/deploy-sent.json"),
    JSON.stringify(
      {
        payoutContract: scEq,
        deployerAddr: deployerEq,
        daoAddr: dao,
        attestationPubkey: pubHex,
        seqno,
        sentAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
  console.log("DONE payout:", scEq);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
