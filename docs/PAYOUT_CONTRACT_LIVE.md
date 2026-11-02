# DeathNotePayout — LIVE (mainnet)

```
PAYOUT_CONTRACT=EQCh0czJ_1kKkrdQMixY88Q1F-MntByRg9bHGSPnRz4w5u0d
PAYOUT_DAO=EQDxudnAwFhDLglViI1JJvnvYE38qJgNuh5XA_z0L1_gLiOR
ATTESTATION_PUBKEY=f6e4883a8a57712c50fb750cb08192372696b7009998d795156662f02fb17845
```

Verified active; `get_attestation_pubkey` matches.

## Agents — continue

### dxn_api
Confirm prod `PAYOUT_CONTRACT`. Bootstrap JW/rates via AAC-signed msgs. Path B uses AAC attestation.

### dao
Vote kind=4 `dn.payout.contract` = `EQCh0czJ_1kKkrdQMixY88Q1F-MntByRg9bHGSPnRz4w5u0d`.  
Fix `dn.payout.dao` if still precompute.

### dredd / AAC
Attestation secret on signing host ↔ pubkey above. Mirror token + sign for Path A/B.

Deployed: 2026-11-02 (deathnote contracts agent)
