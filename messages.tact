// DeathNotePayout messages. Opcode prefix 0x444e = "DN".
// Privilege model: no publishers/ops maps.
// Register*/Mark*/Set*/Apply*/ProposeRotate require AAC ed25519 attestation
// (signature over cell hash; pubkey baked in SC; rare rotate via Propose+Finalize).

/// Merchant credit via jetton forward_payload.
message(0x444e0001) CreditMemo {
    isKubyshka: Bool;
    subjectId: String;
}

/// Anyone may send; SC checks AAC signature + expiresAt.
/// appealSec/cap come from AAC (DaoParam off-chain) — not attacker-chosen alone.
message(0x444e0010) RegisterDecision {
    queryId: Int as uint64;
    decisionId: String;
    subjectId: String;
    payee: Address;
    publishedAt: Int as uint32;
    appealSec: Int as uint32;
    cap: Int as coins;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

message(0x444e0011) MarkAppealed {
    queryId: Int as uint64;
    decisionId: String;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

message(0x444e0012) SetPayee {
    queryId: Int as uint64;
    decisionId: String;
    payee: Address;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

message(0x444e0020) Claim {
    queryId: Int as uint64;
    decisionId: String;
}

/// JW / rates / profit_bps — AAC-signed only (no ops key).
message(0x444e0031) SetJettonWallet {
    queryId: Int as uint64;
    wallet: Address;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

message(0x444e0032) SetBlcWallet {
    queryId: Int as uint64;
    wallet: Address;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

message(0x444e0033) SetProfitBps {
    queryId: Int as uint64;
    profitBps: Int as uint16;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

message(0x444e0034) SyncRates {
    queryId: Int as uint64;
    tonUsd6: Int as uint64;
    blcUsd6: Int as uint64;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

/// Permissionless skim of accrued profit → daoAddr (BLC → TON → USDT).
message(0x444e0040) SweepProfit {
    queryId: Int as uint64;
    usd6: Int as coins;
}

/// AAC signs proposal of new pubkey; unlocks after rotateDelaySec.
message(0x444e0050) ProposeRotatePubkey {
    queryId: Int as uint64;
    newPubkey: Int as uint256;
    expiresAt: Int as uint32;
    signature: Slice as bytes64;
}

/// Anyone after pendingUnlockAt — applies pending pubkey.
message(0x444e0051) FinalizeRotatePubkey {
    queryId: Int as uint64;
}
