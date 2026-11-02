# DeathNotePayout — деплой по шагам

Сеть: **TON mainnet** (если иначе — сказать явно).

## Модель ролей (актуальная)

### Публикация — кто угодно **только с on-chain проверкой attestation AAC**
См. `docs/AUDIT_PERMISSIONLESS_MIRROR.md`. «Проверил AAC в браузере» ≠ безопасность.

### Ops-ключа нет: кассу ведёт сам SC
- прибыль `profitBps` — accrue при credit; `SweepProfit` (кто угодно) → `daoAddr`
- JW / rates / profitBps — только AAC-signed сообщения
- deploy gas — разово любой (казна DN может оплатить), не runtime-роль

### Ключ attestation
1. На **сервере AAC** (не в чате): `node scripts/gen-ton-attestation-key.mjs`
2. Secret → `AAC_TON_ATTESTATION_SECRET_PATH` (0600), **не в git**
3. Public hex → init `attestationPubkey` + `config/ton_attestation_pubkey.hex`
4. Ротация: `ProposeRotatePubkey` (подпись текущего) → timelock → `FinalizeRotatePubkey`

### DAO DXN
DaoParam + прибыль. Не owner SC.

## Шаг 0 — ключ на AAC-хосте (агент / sysadmin)

```bash
# на машине подписи AAC, один раз:
export AAC_TON_ATTESTATION_SECRET_PATH=/var/lib/aac/ton_attestation_ed25519.secret
export AAC_TON_ATTESTATION_PUBKEY_PATH=./config/ton_attestation_pubkey.hex
node scripts/gen-ton-attestation-key.mjs
# в лог/чат уходит ТОЛЬКО public hex
```

## Шаг 1 — от тебя (после DAO)

| # | Что |
|---|---|
| 1 | `DAO_ADDR` |
| 2 | кто платит **разовый** газ деплоя (адрес казны DN) |
| 3 | public hex attestation (из шага 0) |

## Шаг 2 — агент (после шага 1)

- Пересобрать контракт
- Init: dao, JW, BLC JW, kubyshkaKey, **attestationPubkey**, pending=0, rotateDelaySec=604800, profitBps=2000, rates=0
- Показать **будущий** адрес SC и сумму газа (~0.3–1 TON)

## Шаг 3 — от тебя

- Пополнить `DEPLOYER_ADDR` на газ
- Сказать «можно деплоить» и способ подписи

## Шаг 4 — агент

- Отправить StateInit
- Дождаться активации, проверить `get_attestation_pubkey`

## Шаг 5 — AAC-signed bootstrap (агент)

- Discover USDT / BLC jetton wallets контракта
- AAC подписывает `SetJettonWallet`, `SetBlcWallet`, `SyncRates`, `SetProfitBps` — broadcast кто угодно

## Шаг 6 — ты в DAO

- Голоса: `dn.payout.contract`, `dn.payout.dao`, `dn.payout.cap`, `court.sources`, `dn.payout.profit_bps`

## Шаг 7 — dxn_api / dredd env

- `PAYOUT_CONTRACT=…`, `PAYOUT_DAO=…`
- AAC: `AAC_TON_ATTESTATION_SECRET_PATH` (только на signing host)
- Path A/B: берут attestation у AAC, **не** держат publishers mnemonic для RegisterDecision
