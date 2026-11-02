# ТЗ: автовыплаты пула Death Note (TON)

## Жёсткое правило выплаты

Выплата **только** при выполнении всех условий:

1. Есть **on-chain запись решения суда** ATS на TON (`DecisionRecord`: нейтрализатор = payee, фигурант = `subject_id`)
2. С момента `publishedAt` прошло **N = appealSec** и решение **осталось без обжалования**
3. По этому кейсу ещё **не платили**
4. Сумма: `figure + min(kubyshka, cap)` в USD-эквиваленте; выдача **корзиной монет** на TON (см. приоритет)

Без решения суда — **никак**.

Источник истины по факту решения = **ETH ATS**. На TON — зеркало outlaw-кейсов (`murderer` / `kidnapper` / `rapist`).

## Формула суммы

```
payout_usd = balance_usd(figure) + min(balance_usd(kubyshka), cap_usd)
```

После claim: figure → 0; из кубышки − взятая доля (в рамках cap).

## Инкассация (merchant / dxn_api)

| Вход | Действие |
|---|---|
| **Вне TON** (BTC, XMR, USDT·TRON, …) | автосвап → активы кассы на TON → credit в Payout SC |
| **Сеть TON** (TON, BLC, USDT·TON, …) | **без свапа в другую сеть**; credit на Payout SC; списание по приоритетам ниже |

## Прибыль DAO vs выплата охотнику — приоритеты активов

Доля прибыли: DaoParam `dn.payout.profit_bps` (старт **20%** = `2000`), меняется **голосованием**.  
Куда слать прибыль: кошелёк **DAO DXN** (`dn.payout.dao`).

Один и тот же набор монет на кассе, **разный порядок списания**:

### Прибыль → DAO DXN

1. **BLC** — первый  
2. **TON**  
3. **USDT·TON**  
4. прочие при необходимости  

### Выплата охотнику (claim)

1. **USDT·TON** — первый  
2. **TON**  
3. прочие (кроме BLC)  
4. **BLC** — последний  

BLC охотнику **не запрещён голосованием** — просто самый низкий приоритет в корзине claim.  
Сумма claim в USD = `figure + min(kubyshka, cap)` в пределах ликвидности кассы.

## Payee (нейтрализатор)

- Предпочтительно: `plaintiffs[]` с `wallet` + `network: ton`, `visibility: public`.
- Путь публикации DecisionRecord на TON (**A/B ниже**) работает **независимо** от того, подключил ли истец TON-кошелёк в момент иска: зеркало outlaw-решения всё равно ставится; payee дописывается/обновляется, когда TON-адрес известен (из решения / доп. поля / поздней правки publisher).

## Дубль ETH → TON (dredd + dxn_api)

Только лейблы тетради: `murderer` | `kidnapper` | `rapist`.

После успешного `publishDecision` в ETH:

### Публикация на TON — permissionless + сверка с ETH

`RegisterDecision` / `MarkAppealed` может слать **кто угодно** (суд, охотник, бот DN).  
Обязательно: данные **совпадают** с уже опубликованным решением в ETH registry.

Проверка без «чужого» оракула on-chain невозможна → **AAC API** выдаёт/подтверждает attestation
(decisionId, subject, payee, publishedAt, ethTx/registry id). Клиент/бот шлёт tx только после ok.
Дубликат `decisionId` на SC отвергается.

Очередь A/B в кабинете — UX: суд может подписать сам или decline → бот DN дотягивает газ/удобство,
но **не** эксклюзивное право публикации и **не** доступ к кассе.

## Траст-модель

| Слой | Роль |
|---|---|
| ETH ATS | истина решения |
| AAC attestation | ed25519: сверила ETH → подпись для TON SC (secret только на signing host) |
| TON DecisionRecord | зеркало outlaw для claim (кто угодно + valid attestation) |
| Payout SC | касса + claim; `attestationPubkey` + rare rotate |
| DAO DXN | DaoParam (cap, appealSec, profit_bps, …); **не владеет** SC |
| Merchant dxn_api | инкассация; Path B бродкаст с attestation |
| Path A UX | суд платит газ / decline → B (не эксклюзивное право) |

## Пакет DaoParam (голосуй kind=4)

### Обязательные

| Ключ | Тип | Значение | Зачем |
|---|---|---|---|
| `court.sources` | str JSON | Kebe + `appealSec` | N без обжалования |
| `dn.payout.cap` | num | `10000000000` | cap кубышки (USDT 6 dec) |
| `dn.payout.asset` | str | USDT master | якорь курса/cap |
| `dn.payout.network` | str | `ton` | сеть кассы |
| `dn.payout.kubyshka_id` | str | `__general__` | id кубышки |
| `dn.payout.dao` | str | адрес DAO DXN | прибыль + витрина |
| `dn.payout.contract` | str | после деплоя | SC |
| `dn.payout.profit_bps` | num | `2000` | % прибыли → DAO (голосуемо); списание: BLC → TON → USDT |

### `court.sources`

```json
[
  {
    "id": "acb651b1-022e-4d83-b60b-e02de2ec649e",
    "name": "Kebe",
    "apiBase": "https://aac.cab",
    "appealSec": 864000
  }
]
```

## Репозитории

| Часть | Где |
|---|---|
| Payout SC | `deathnote/contracts/` |
| Merchant, publisher B, mirror | `dxn_api` |
| Путь A Sign TON + очередь B | `dredd` |
| DaoParam | голоса в DAO DXN (`dao` код не трогать) |
| UI memo/hunters | `deathnote/src/` |

## Архитектура

```
Donate non-TON → swap → TON assets → PayoutSC
Donate TON/USDT/BLC → credit PayoutSC (no cross-chain swap)
Profit → DAO: BLC → TON → USDT
ETH publishDecision (outlaw) → A court TON sign
                            → else B dxn_api DeathNote TON publisher
Anyone → claim → USDT → TON → other → BLC last (by rate)
```
