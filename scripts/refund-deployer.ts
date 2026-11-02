/**
 * Return leftover TON from deploy wallet → original funder.
 * Destination: UQCUd6x9Zz4SNiQjvPPMu_FMGsiXNBBJOcTvAOVCK5BpTT7R
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
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
} from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MNEMONIC_PATH = resolve(ROOT, "deploy-out/deployer.mnemonic");
const REFUND_TO = Address.parse(
  process.env.REFUND_TO || "UQCUd6x9Zz4SNiQjvPPMu_FMGsiXNBBJOcTvAOVCK5BpTT7R"
);

async function tonapiGet(path: string) {
  const r = await fetch(`https://tonapi.io/v2${path}`);
  if (!r.ok) throw new Error(`tonapi GET ${path}: ${r.status}`);
  return r.json();
}

async function tonapiSendBoc(bocB64: string) {
  const r = await fetch("https://tonapi.io/v2/blockchain/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boc: bocB64 }),
  });
  if (!r.ok) throw new Error(`tonapi send: ${r.status} ${await r.text()}`);
}

async function main() {
  if (!existsSync(MNEMONIC_PATH)) throw new Error("no deployer mnemonic");
  const words = readFileSync(MNEMONIC_PATH, "utf8").trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const raw = wallet.address.toRawString();
  const acc = await tonapiGet(`/accounts/${raw}`);
  const bal = BigInt(acc.balance);
  console.log(
    `Deployer bal=${Number(bal) / 1e9} → ${REFUND_TO.toString({ bounceable: false, urlSafe: true })}`
  );
  if (bal < toNano("0.05")) {
    console.log("Nothing meaningful to refund");
    return;
  }

  const seqRes = await fetch(
    `https://tonapi.io/v2/blockchain/accounts/${raw}/methods/seqno`,
    { method: "POST" }
  );
  const seqJson = (await seqRes.json()) as {
    stack?: { num?: string }[];
  };
  const seqno = Number(seqJson.stack?.[0]?.num ?? "0");

  // Leave ~0.02 for fees; send rest
  const sendAmount = bal - toNano("0.02");
  const transfer = wallet.createTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
    messages: [
      internal({
        to: REFUND_TO,
        value: sendAmount,
        bounce: false,
        body: beginCell()
          .storeUint(0, 32)
          .storeStringTail("dn payout deploy leftover refund")
          .endCell(),
      }),
    ],
  });

  const ext = external({ to: wallet.address, body: transfer });
  const boc = beginCell().store(storeMessage(ext)).endCell();
  await tonapiSendBoc(boc.toBoc().toString("base64"));
  console.log(`Refund sent: ${Number(sendAmount) / 1e9} TON`);
  writeFileSync(
    resolve(ROOT, "deploy-out/refund-sent.json"),
    JSON.stringify(
      {
        to: REFUND_TO.toString({ bounceable: false, urlSafe: true }),
        amountTon: Number(sendAmount) / 1e9,
        seqno,
        sentAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
