#!/usr/bin/env node
/**
 * Compute DeathNotePayout address + optional mainnet deploy.
 *
 * Required:
 *   DAO_ADDR=EQ...
 *   ATTESTATION_PUBKEY_HEX=<64 hex>  (or reads AAC_TON_ATTESTATION_PUBKEY_PATH)
 *
 * Optional:
 *   USDT_JW / BLC_JW  (default: zero address — set later via AAC-signed Set*)
 *   PROFIT_BPS=2000
 *   ROTATE_DELAY_SEC=604800
 *   KUBYSHKA_ID=__general__
 *   DEPLOY_VALUE_TON=0.5
 *   TON_ENDPOINT / TON_API_KEY  (toncenter)
 *   DEPLOY_MNEMONIC  — if set, sends StateInit to mainnet
 *
 * Without mnemonic: prints future address + gas hint only (no secret printed).
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Address, beginCell, toNano, Dictionary, SendMode } from '@ton/core';
import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

async function loadBindings() {
  const mod = await import(
    resolve(ROOT, 'build/deathnote_payout_DeathNotePayout.ts')
  );
  return mod;
}

function sha256Str(s) {
  return BigInt('0x' + createHash('sha256').update(s, 'utf8').digest('hex'));
}

function readPubkeyHex() {
  const envHex = (process.env.ATTESTATION_PUBKEY_HEX || '').replace(/^0x/, '');
  if (/^[0-9a-fA-F]{64}$/.test(envHex)) return envHex.toLowerCase();
  const path =
    process.env.AAC_TON_ATTESTATION_PUBKEY_PATH ||
    resolve(ROOT, '../../dredd/config/ton_attestation_pubkey.hex');
  // also try sibling / absolute dredd
  const candidates = [
    path,
    'C:/git/dredd/config/ton_attestation_pubkey.hex',
    resolve(ROOT, '../config/ton_attestation_pubkey.hex'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const h = readFileSync(p, 'utf8').trim().replace(/^0x/, '');
      if (/^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
    }
  }
  throw new Error('ATTESTATION_PUBKEY_HEX or pubkey file required');
}

function zeroAddr() {
  return Address.parseRaw(
    '0:0000000000000000000000000000000000000000000000000000000000000000'
  );
}

async function main() {
  const { DeathNotePayout } = await loadBindings();

  const daoAddr = Address.parse(process.env.DAO_ADDR || '');
  const pubHex = readPubkeyHex();
  const attestationPubkey = BigInt('0x' + pubHex);
  const kubyshkaKey = sha256Str(process.env.KUBYSHKA_ID || '__general__');
  const profitBps = BigInt(process.env.PROFIT_BPS || '2000');
  const rotateDelaySec = BigInt(process.env.ROTATE_DELAY_SEC || '604800');
  const jettonWallet = process.env.USDT_JW
    ? Address.parse(process.env.USDT_JW)
    : zeroAddr();
  const blcWallet = process.env.BLC_JW
    ? Address.parse(process.env.BLC_JW)
    : zeroAddr();

  const emptyBal = Dictionary.empty(Dictionary.Keys.BigInt(256), Dictionary.Values.BigInt(257));
  // DecisionRecord / Bool dicts — use empty from init helper; bindings expect Dictionary
  const emptyDec = Dictionary.empty();
  const emptyPaid = Dictionary.empty();

  const contract = await DeathNotePayout.fromInit(
    daoAddr,
    jettonWallet,
    blcWallet,
    kubyshkaKey,
    attestationPubkey,
    0n, // pendingPubkey
    0n, // pendingUnlockAt
    rotateDelaySec,
    emptyBal,
    0n,
    emptyDec,
    emptyPaid,
    profitBps,
    0n,
    0n,
    0n,
    0n,
    0n
  );

  const addr = contract.address.toString({ bounceable: true, urlSafe: true });
  const valueTon = process.env.DEPLOY_VALUE_TON || '0.5';

  const outDir = resolve(ROOT, 'deploy-out');
  mkdirSync(outDir, { recursive: true });
  const meta = {
    network: 'mainnet',
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
  writeFileSync(resolve(outDir, 'deploy-meta.json'), JSON.stringify(meta, null, 2));

  console.log(JSON.stringify(meta, null, 2));
  console.log(`\nFuture SC address: ${addr}`);
  console.log(`Fund deployer with ≥ ${valueTon} TON, then:`);
  console.log(`  DEPLOY_MNEMONIC="..." DAO_ADDR=... node scripts/deploy.mjs --send`);

  if (!process.argv.includes('--send')) {
    return;
  }

  const mnemonic = process.env.DEPLOY_MNEMONIC;
  if (!mnemonic) {
    throw new Error('DEPLOY_MNEMONIC required for --send');
  }
  const words = mnemonic.trim().split(/\s+/);
  const keyPair = await mnemonicToPrivateKey(words);
  const endpoint =
    process.env.TON_ENDPOINT ||
    'https://toncenter.com/api/v2/jsonRPC';
  const client = new TonClient({
    endpoint,
    apiKey: process.env.TON_API_KEY || undefined,
  });
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const walletContract = client.open(wallet);
  const deployerAddr = wallet.address.toString({ bounceable: true, urlSafe: true });
  console.log(`Deployer: ${deployerAddr}`);

  const balance = await walletContract.getBalance();
  console.log(`Deployer balance: ${Number(balance) / 1e9} TON`);
  if (balance < toNano(valueTon)) {
    throw new Error(
      `Insufficient balance on ${deployerAddr}: need ≥ ${valueTon} TON`
    );
  }

  const seqno = await walletContract.getSeqno();
  await walletContract.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS,
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
  console.log('Deploy tx sent. Wait ~15s then verify get_attestation_pubkey.');
  writeFileSync(
    resolve(outDir, 'deploy-sent.json'),
    JSON.stringify({ ...meta, deployerAddr, seqno, sentAt: new Date().toISOString() }, null, 2)
  );
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
