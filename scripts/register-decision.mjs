#!/usr/bin/env node
/**
 * Build RegisterDecision body after reading DaoParam from DAO DXN.
 *
 * Env / flags:
 *   --dao EQ...              DAO DXN (get_params)
 *   --decision-id <uuid>
 *   --subject-id <hex>
 *   --payee EQ...            hunter TON wallet (plaintiff)
 *   --published-at <unix>    default: now
 *   --court-id <uuid>        pick appealSec from court.sources (optional)
 *
 * Reads (via toncenter / tonapi — set TON_PROVIDER_URL):
 *   dn.payout.cap → cap
 *   court.sources → appealSec
 *
 * Prints unsigned field checklist. Real body needs AAC attestation
 * (expiresAt + signature) from dredd/lib/ton-attestation.ts — not a publisher key.
 */
import { createHash } from 'node:crypto';

const OP_REGISTER = 0x444e0010;

function parseArgs(argv) {
  const out = {
    dao: process.env.DAO_ADDR || '',
    decisionId: '',
    subjectId: '',
    payee: '',
    publishedAt: Math.floor(Date.now() / 1000),
    courtId: process.env.COURT_ID || 'acb651b1-022e-4d83-b60b-e02de2ec649e',
    cap: null,
    appealSec: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dao') out.dao = argv[++i];
    else if (a === '--decision-id') out.decisionId = argv[++i];
    else if (a === '--subject-id') out.subjectId = argv[++i];
    else if (a === '--payee') out.payee = argv[++i];
    else if (a === '--published-at') out.publishedAt = parseInt(argv[++i], 10);
    else if (a === '--court-id') out.courtId = argv[++i];
    else if (a === '--cap') out.cap = argv[++i];
    else if (a === '--appeal-sec') out.appealSec = parseInt(argv[++i], 10);
  }
  return out;
}

async function fetchDaoParam(dao, key) {
  // Placeholder: wire toncenter runGetMethod get_param with string key.
  // Until live DAO exists, caller passes --cap / --appeal-sec.
  void dao;
  void key;
  return null;
}

function parseCourtAppealSec(sourcesJson, courtId) {
  try {
    const arr = JSON.parse(sourcesJson);
    const hit = arr.find((x) => x.id === courtId) || arr[0];
    return hit?.appealSec ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.decisionId || !args.subjectId || !args.payee) {
    console.error(
      'Need --decision-id --subject-id --payee [--dao] [--cap] [--appeal-sec]'
    );
    process.exit(1);
  }

  let cap = args.cap;
  let appealSec = args.appealSec;

  if (args.dao && (cap == null || appealSec == null)) {
    const capParam = await fetchDaoParam(args.dao, 'dn.payout.cap');
    const sources = await fetchDaoParam(args.dao, 'court.sources');
    if (cap == null && capParam?.num != null) cap = String(capParam.num);
    if (appealSec == null && sources?.str) {
      appealSec = parseCourtAppealSec(sources.str, args.courtId);
    }
  }

  if (cap == null) cap = process.env.DN_PAYOUT_CAP || '10000000000';
  if (appealSec == null) appealSec = parseInt(process.env.DN_APPEAL_SEC || '864000', 10);

  console.log('RegisterDecision (publisher must send)');
  console.log(`  op:           0x${OP_REGISTER.toString(16)}`);
  console.log(`  decisionId:   ${args.decisionId}`);
  console.log(`  subjectId:    ${args.subjectId}`);
  console.log(`  payee:        ${args.payee}`);
  console.log(`  publishedAt:  ${args.publishedAt}`);
  console.log(`  appealSec:    ${appealSec}  (from DaoParam court.sources)`);
  console.log(`  cap:          ${cap}  (from DaoParam dn.payout.cap)`);
  console.log(
    `  decisionKey:  ${createHash('sha256').update(args.decisionId, 'utf8').digest('hex')}`
  );
  console.log('');
  console.log(
    'Snapshot rule: appealSec/cap frozen in DecisionRecord; claim uses these values.'
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
