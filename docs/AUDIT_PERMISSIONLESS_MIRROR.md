# Аудит: permissionless RegisterDecision + сверка с ETH (AAC)

## Вердикт

План «кто угодно пишет, главное = как на ETH» **рабочий только если проверка привязана к SC**, а не «клиент сам честно сходил в AAC».  
Иначе это security theatre: злоумышленник шлёт любой `RegisterDecision` напрямую в SC.

Полный trustless ETH→TON light client **сейчас нереалистичен** для этого продукта (дорого, долго, мало зрелых ETH-on-TON верификаторов). Практичный минимум доверия: **AAC (или ключ суда/registry), чью подпись проверяет SC**.

---

## Дыры, если «AAC только помогает клиенту» (без on-chain verify)

| # | Дыра | Атака | Импакт |
|---|---|---|---|
| 1 | **Client-side only check** | Bypass UI/бота, сырой tx на SC | Подставить свой `payee` на чужой `decisionId` → увести bounty |
| 2 | **First-writer wins** | Успеть записать фейк до честного зеркала | Тот же угон; честный дубль → `decision exists` |
| 3 | **SetPayee без проверки** | Сменить payee после честной записи | Угон до claim |
| 4 | **MarkAppealed без проверки** | Ложная апелляция | DoS выплаты; или **не** пометить реальную апелляцию | DoS / выплата после отмены на ETH |
| 5 | **Wrong subject_id** | Списать чужую figure / чужой subject | Неверный claim / griefing ledger |
| 6 | **appealSec/cap от отправителя** | Занизить appealSec=1, cap=max | Ранний claim / раздуть кубышку в формуле |
| 7 | **Нет outlaw-фильтра on-chain** | Зеркало гражданских дел | Шум / ошибочные claim при совпадении id |
| 8 | **AAC API компрометация / подмена** | Если attestation подписывает только API | Подпись = новый trust root (лучше, чем «кто угодно», но не ETH light client) |
| 9 | **Replay attestation** | Старая подпись после смены payee на ETH | Нужны expiry + привязка к ethTx/registry revision |
| 10 | **Race claim vs appeal** | Claim в окне, пока MarkAppealed не доехал | Выплата после ETH appeal |

---

## Что считать минимально приемлемым

### On-chain (SC)

1. `RegisterDecision` / `MarkAppealed` / `SetPayee` — **не** по allowlist «друзей», а по **проверке attestation** (ed25519 / ключ AAC или publisher court vault schema — выбрать одно).
2. В attestation жёстко: `decisionId`, `subjectId`, `payee`, `publishedAt`, `ethRegistryId`/`ethTx`, `contentHash`, `op`, `expiresAt`.
3. `appealSec` / `cap` — **не из произвольного msg**, а из **уже записанных на SC** DaoParam-снимков (`SyncDaoParams` / init), иначе дыра #6.
4. Outlaw: либо флаг в attestation `outlaw=1` (AAC считает лейблы), либо SC не принимает без него.
5. `SetPayee` — только новая attestation с тем же `decisionId` и новым payee (как на ETH).
6. Дубликат `decisionId` — reject.

### Off-chain (AAC)

- Endpoint: «выдай attestation для зеркала TON» только если ETH registry already has matching final/outlaw decision.
- Короткий TTL, nonce/registry id, отказ если labels не outlaw.
- Публичный ключ AAC verification key зашит в SC при деплое (или редкий rotate через … см. ops ниже).

### UX A/B

Остаётся **удобством газа**, не security boundary.

---

## Что не закрывает AAC attestation

- Баг/взлом AAC signer → тот же класс риска, что компрометация Path B ключа сегодня, но **без** права на кассу.
- ETH reorg крайне маловероятен после final; всё равно лучше attestation только после N confirmations.
- Полный trustless ETH proof — отдельный R&D (месяцы), не блокер MVP.

---

## Рекомендация по плану 2

| Вариант | Trust | Сложность | Для DN |
|---|---|---|---|
| A. Client AAC check only | **FAIL** | низкая | не брать |
| B. SC verifies AAC attestation | OK MVP | средняя | **брать** |
| C. ETH light client on TON | best | очень высокая | позже |

---

## Ops → делает сам Payout SC (план 3)

Отдельный ops-ключ **не нужен**, если:

| Было ops | Делает SC |
|---|---|
| TakeProfit вручную | При **каждом credit**: `profit = amount * profitBps / 10000` сразу корзиной на `daoAddr` (или accrued + permissionless `SkimProfit` **anyone** в пределах accrued) |
| SetJettonWallet / SetBlc | В **init**: `usdtMaster` / `blcMaster`; JW = `contractAddress(initOf JettonWallet(…))` или accept notify только от JW, вычисленных от master+owner=SC |
| SyncRates | Курсы: snapshot при credit из msg с **той же** attestation/DAO sync; или claim/credit в **USDT-only учёте**, TON/BLC physical с оракулом позже |
| SetProfitBps | Только через **новый деплой** или редкий `ApplyDaoParam` после AAC/DAO attestation (не hot ops key) |
| Deploy gas | Любой оплачивает StateInit; казна DN может заплатить раз — не роль в runtime |

Итого runtime привилегий: **нет publishers map, нет ops map**. Есть `daoAddr` + `attestationPubkey` в storage + `ProposeRotatePubkey` / `FinalizeRotatePubkey` (timelock).

Ключ: генерится **на сервере AAC** (`scripts/gen-ton-attestation-key.mjs`), secret только в `AAC_TON_ATTESTATION_SECRET_PATH` (0600), в SC/чат/git — только public hex. ETH→TON snapshots DaoParam — phase 2 (не MVP).
