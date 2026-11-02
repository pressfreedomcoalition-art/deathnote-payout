// DeathNotePayout — ledger (usd6) + DecisionRecord + claim basket + DAO profit.
// Formula: payout_usd = figure + min(kubyshka, cap)
// Claim asset order: USDT → TON → other → BLC
// Profit asset order: BLC → TON → USDT
//
// Trust: AAC ed25519 attestationPubkey (baked at deploy). No publishers/ops maps.
// Rotation: ProposeRotatePubkey (signed by current) → FinalizeRotatePubkey after delay.
import "./messages.tact";
import "./jetton_messages.tact";

struct DecisionRecord {
    subjectKey: Int as uint256;
    payee: Address;
    publishedAt: Int as uint32;
    appealSec: Int as uint32;
    cap: Int as coins;
    appealed: Bool;
    paid: Bool;
}

fun subjectKeyOf(subjectId: String): Int { return sha256(subjectId); }
fun decisionKeyOf(decisionId: String): Int { return sha256(decisionId); }
fun minInt(a: Int, b: Int): Int { if (a < b) { return a; } return b; }

/// Domain-separated cell hash for AAC signatures (must match dredd ton-attestation.ts).
fun attestHashRegister(
    decisionId: String,
    subjectId: String,
    payee: Address,
    publishedAt: Int,
    appealSec: Int,
    cap: Int,
    expiresAt: Int,
): Int {
    return beginCell()
        .storeUint(0x444e0010, 32)
        .storeUint(sha256(decisionId), 256)
        .storeUint(sha256(subjectId), 256)
        .storeAddress(payee)
        .storeUint(publishedAt, 32)
        .storeUint(appealSec, 32)
        .storeCoins(cap)
        .storeUint(expiresAt, 32)
        .endCell()
        .hash();
}

fun attestHashMark(decisionId: String, expiresAt: Int): Int {
    return beginCell()
        .storeUint(0x444e0011, 32)
        .storeUint(sha256(decisionId), 256)
        .storeUint(expiresAt, 32)
        .endCell()
        .hash();
}

fun attestHashPayee(decisionId: String, payee: Address, expiresAt: Int): Int {
    return beginCell()
        .storeUint(0x444e0012, 32)
        .storeUint(sha256(decisionId), 256)
        .storeAddress(payee)
        .storeUint(expiresAt, 32)
        .endCell()
        .hash();
}

fun attestHashWallet(op: Int, wallet: Address, expiresAt: Int): Int {
    return beginCell()
        .storeUint(op, 32)
        .storeAddress(wallet)
        .storeUint(expiresAt, 32)
        .endCell()
        .hash();
}

fun attestHashBps(profitBps: Int, expiresAt: Int): Int {
    return beginCell()
        .storeUint(0x444e0033, 32)
        .storeUint(profitBps, 16)
        .storeUint(expiresAt, 32)
        .endCell()
        .hash();
}

fun attestHashRates(tonUsd6: Int, blcUsd6: Int, expiresAt: Int): Int {
    return beginCell()
        .storeUint(0x444e0034, 32)
        .storeUint(tonUsd6, 64)
        .storeUint(blcUsd6, 64)
        .storeUint(expiresAt, 32)
        .endCell()
        .hash();
}

fun attestHashRotate(newPubkey: Int, expiresAt: Int): Int {
    return beginCell()
        .storeUint(0x444e0050, 32)
        .storeUint(newPubkey, 256)
        .storeUint(expiresAt, 32)
        .endCell()
        .hash();
}

contract DeathNotePayout(
    daoAddr: Address,
    jettonWallet: Address,
    blcWallet: Address,
    kubyshkaKey: Int as uint256,
    attestationPubkey: Int as uint256,
    pendingPubkey: Int as uint256,
    pendingUnlockAt: Int as uint32,
    rotateDelaySec: Int as uint32, // e.g. 7 days
    balances: map<Int, Int>,
    kubyshkaBalance: Int as coins,
    decisions: map<Int, DecisionRecord>,
    paidSubjects: map<Int, Bool>,
    profitBps: Int as uint16,
    accruedProfitUsd6: Int as coins,
    tonUsd6: Int as uint64,
    blcUsd6: Int as uint64,
    usdtPhysical: Int as coins,
    blcPhysical: Int as coins,
) {
    receive() { }

    fun requireAttest(hash: Int, signature: Slice, expiresAt: Int) {
        require(now() <= expiresAt, "attestation expired");
        require(checkSignature(hash, signature, self.attestationPubkey), "bad attestation");
    }

    fun creditUsd(isKubyshka: Bool, subjectId: String, usd6: Int) {
        if (isKubyshka || subjectId == "" || subjectId == "__general__") {
            self.kubyshkaBalance = self.kubyshkaBalance + usd6;
        } else {
            let key: Int = subjectKeyOf(subjectId);
            let prev: Int = self.balances.get(key) != null ? self.balances.get(key)!! : 0;
            self.balances.set(key, prev + usd6);
        }
        if (self.profitBps > 0 && usd6 > 0) {
            let share: Int = (usd6 * self.profitBps) / 10000;
            if (share > 0) {
                self.accruedProfitUsd6 = self.accruedProfitUsd6 + share;
            }
        }
    }

    fun parseCreditMemo(fp: Slice): CreditMemo? {
        if (fp.bits() >= 1 && fp.preloadUint(1) == 1) {
            fp.loadUint(1);
            let body: Slice = fp.loadRef().beginParse();
            if (body.bits() >= 32 && body.preloadUint(32) == CreditMemo.opcode()) {
                return CreditMemo.fromSlice(body);
            }
            return null;
        }
        if (fp.bits() >= 32 && fp.preloadUint(32) == CreditMemo.opcode()) {
            return CreditMemo.fromSlice(fp);
        }
        return null;
    }

    fun sendJetton(jw: Address, amount: Int, dest: Address, queryId: Int) {
        if (amount <= 0) { return; }
        send(SendParameters{
            to: jw,
            value: ton("0.12"),
            bounce: true,
            body: JettonTransfer{
                queryId: queryId,
                amount: amount,
                destination: dest,
                responseDestination: myAddress(),
                customPayload: null,
                forwardTonAmount: ton("0.01"),
                forwardPayload: beginCell().storeUint(0, 1).asSlice(),
            }.toCell(),
        });
    }

    fun payTonUsd(need: Int, dest: Address): Int {
        if (need <= 0 || self.tonUsd6 <= 0) { return need; }
        let reserve: Int = ton("0.2");
        let avail: Int = myBalance() - reserve;
        if (avail < 0) { avail = 0; }
        let nanoWant: Int = (need * 1000000000) / self.tonUsd6;
        let nano: Int = minInt(nanoWant, avail);
        if (nano <= 0) { return need; }
        let covered: Int = (nano * self.tonUsd6) / 1000000000;
        send(SendParameters{
            to: dest,
            value: nano,
            bounce: false,
            mode: SendIgnoreErrors,
            body: beginCell().endCell(),
        });
        let left: Int = need - covered;
        return left < 0 ? 0 : left;
    }

    fun payBlcUsd(need: Int, dest: Address, queryId: Int): Int {
        if (need <= 0 || self.blcUsd6 <= 0 || self.blcPhysical <= 0) { return need; }
        let nanoWant: Int = (need * 1000000000) / self.blcUsd6;
        let nano: Int = minInt(nanoWant, self.blcPhysical);
        if (nano <= 0) { return need; }
        let covered: Int = (nano * self.blcUsd6) / 1000000000;
        self.blcPhysical = self.blcPhysical - nano;
        self.sendJetton(self.blcWallet, nano, dest, queryId);
        let left: Int = need - covered;
        return left < 0 ? 0 : left;
    }

    fun payUsdtUsd(need: Int, dest: Address, queryId: Int): Int {
        if (need <= 0) { return need; }
        let u: Int = minInt(need, self.usdtPhysical);
        if (u <= 0) { return need; }
        self.usdtPhysical = self.usdtPhysical - u;
        self.sendJetton(self.jettonWallet, u, dest, queryId);
        return need - u;
    }

    fun spendBasket(needUsd6: Int, dest: Address, queryId: Int, modeProfit: Bool): Int {
        let need: Int = needUsd6;
        if (need <= 0) { return 0; }
        if (modeProfit) {
            need = self.payBlcUsd(need, dest, queryId);
            need = self.payTonUsd(need, dest);
            need = self.payUsdtUsd(need, dest, queryId);
        } else {
            need = self.payUsdtUsd(need, dest, queryId);
            need = self.payTonUsd(need, dest);
            need = self.payBlcUsd(need, dest, queryId);
        }
        return need;
    }

    receive(msg: JettonNotification) {
        require(msg.amount > 0, "zero credit");
        let fromUsdt: Bool = sender() == self.jettonWallet;
        let fromBlc: Bool = sender() == self.blcWallet;
        require(fromUsdt || fromBlc, "unknown jetton wallet");

        let memo: CreditMemo? = self.parseCreditMemo(msg.forwardPayload);
        require(memo != null, "CreditMemo required");
        let m: CreditMemo = memo!!;

        if (fromUsdt) {
            self.usdtPhysical = self.usdtPhysical + msg.amount;
            self.creditUsd(m.isKubyshka, m.subjectId, msg.amount);
        } else {
            require(self.blcUsd6 > 0, "blc rate unset");
            let usd6: Int = (msg.amount * self.blcUsd6) / 1000000000;
            require(usd6 > 0, "blc dust");
            self.blcPhysical = self.blcPhysical + msg.amount;
            self.creditUsd(m.isKubyshka, m.subjectId, usd6);
        }
    }

    receive(msg: RegisterDecision) {
        require(msg.appealSec > 0, "appealSec");
        require(msg.subjectId != "", "subjectId");
        require(msg.decisionId != "", "decisionId");
        require(msg.publishedAt <= now() + 600, "publishedAt future");
        require(now() - msg.publishedAt <= msg.appealSec * 10, "publishedAt stale");

        let h: Int = attestHashRegister(
            msg.decisionId, msg.subjectId, msg.payee,
            msg.publishedAt, msg.appealSec, msg.cap, msg.expiresAt,
        );
        self.requireAttest(h, msg.signature, msg.expiresAt);

        let dKey: Int = decisionKeyOf(msg.decisionId);
        require(self.decisions.get(dKey) == null, "decision exists");
        let sKey: Int = subjectKeyOf(msg.subjectId);
        require(self.paidSubjects.get(sKey) != true, "subject already paid");

        self.decisions.set(dKey, DecisionRecord{
            subjectKey: sKey,
            payee: msg.payee,
            publishedAt: msg.publishedAt,
            appealSec: msg.appealSec,
            cap: msg.cap,
            appealed: false,
            paid: false,
        });
    }

    receive(msg: SetPayee) {
        let h: Int = attestHashPayee(msg.decisionId, msg.payee, msg.expiresAt);
        self.requireAttest(h, msg.signature, msg.expiresAt);
        let dKey: Int = decisionKeyOf(msg.decisionId);
        let rec: DecisionRecord? = self.decisions.get(dKey);
        require(rec != null, "no decision");
        let r: DecisionRecord = rec!!;
        require(!r.paid, "already paid");
        r.payee = msg.payee;
        self.decisions.set(dKey, r);
    }

    receive(msg: MarkAppealed) {
        let h: Int = attestHashMark(msg.decisionId, msg.expiresAt);
        self.requireAttest(h, msg.signature, msg.expiresAt);
        let dKey: Int = decisionKeyOf(msg.decisionId);
        let rec: DecisionRecord? = self.decisions.get(dKey);
        require(rec != null, "no decision");
        let r: DecisionRecord = rec!!;
        require(!r.paid, "already paid");
        r.appealed = true;
        self.decisions.set(dKey, r);
    }

    receive(msg: Claim) {
        let dKey: Int = decisionKeyOf(msg.decisionId);
        let rec: DecisionRecord? = self.decisions.get(dKey);
        require(rec != null, "no decision");
        let r: DecisionRecord = rec!!;

        require(!r.appealed, "appealed");
        require(!r.paid, "already paid");
        require(self.paidSubjects.get(r.subjectKey) != true, "subject paid");
        require(now() >= r.publishedAt + r.appealSec, "appeal window");

        let figureBal: Int = self.balances.get(r.subjectKey) != null ? self.balances.get(r.subjectKey)!! : 0;
        let fromKub: Int = minInt(self.kubyshkaBalance, r.cap);
        let payout: Int = figureBal + fromKub;
        require(payout > 0, "nothing to pay");

        self.balances.set(r.subjectKey, 0);
        self.kubyshkaBalance = self.kubyshkaBalance - fromKub;
        r.paid = true;
        self.decisions.set(dKey, r);
        self.paidSubjects.set(r.subjectKey, true);

        let left: Int = self.spendBasket(payout, r.payee, msg.queryId, false);
        require(left == 0, "insufficient liquidity");
    }

    receive(msg: SweepProfit) {
        require(msg.usd6 > 0, "zero");
        require(msg.usd6 <= self.accruedProfitUsd6, "exceeds accrued");
        self.accruedProfitUsd6 = self.accruedProfitUsd6 - msg.usd6;
        let left: Int = self.spendBasket(msg.usd6, self.daoAddr, msg.queryId, true);
        require(left == 0, "insufficient for profit");
    }

    receive(msg: SetJettonWallet) {
        let h: Int = attestHashWallet(0x444e0031, msg.wallet, msg.expiresAt);
        self.requireAttest(h, msg.signature, msg.expiresAt);
        self.jettonWallet = msg.wallet;
    }

    receive(msg: SetBlcWallet) {
        let h: Int = attestHashWallet(0x444e0032, msg.wallet, msg.expiresAt);
        self.requireAttest(h, msg.signature, msg.expiresAt);
        self.blcWallet = msg.wallet;
    }

    receive(msg: SetProfitBps) {
        require(msg.profitBps <= 10000, "bps");
        let h: Int = attestHashBps(msg.profitBps, msg.expiresAt);
        self.requireAttest(h, msg.signature, msg.expiresAt);
        self.profitBps = msg.profitBps;
    }

    receive(msg: SyncRates) {
        if (msg.tonUsd6 > 0) {
            require(msg.tonUsd6 < 1000000000000, "ton rate");
        }
        if (msg.blcUsd6 > 0) {
            require(msg.blcUsd6 < 1000000000000, "blc rate");
        }
        let h: Int = attestHashRates(msg.tonUsd6, msg.blcUsd6, msg.expiresAt);
        self.requireAttest(h, msg.signature, msg.expiresAt);
        self.tonUsd6 = msg.tonUsd6;
        self.blcUsd6 = msg.blcUsd6;
    }

    receive(msg: ProposeRotatePubkey) {
        require(msg.newPubkey != 0, "zero pubkey");
        require(msg.newPubkey != self.attestationPubkey, "same pubkey");
        let h: Int = attestHashRotate(msg.newPubkey, msg.expiresAt);
        self.requireAttest(h, msg.signature, msg.expiresAt);
        self.pendingPubkey = msg.newPubkey;
        self.pendingUnlockAt = now() + self.rotateDelaySec;
    }

    receive(msg: FinalizeRotatePubkey) {
        let _: Int = msg.queryId;
        require(self.pendingPubkey != 0, "no pending");
        require(now() >= self.pendingUnlockAt, "rotate locked");
        self.attestationPubkey = self.pendingPubkey;
        self.pendingPubkey = 0;
        self.pendingUnlockAt = 0;
    }

    receive(msg: JettonExcesses) {
        let _: Int = msg.queryId;
    }

    get fun get_dao_addr(): Address { return self.daoAddr; }
    get fun get_jetton_wallet(): Address { return self.jettonWallet; }
    get fun get_blc_wallet(): Address { return self.blcWallet; }
    get fun get_kubyshka_balance(): Int { return self.kubyshkaBalance; }
    get fun get_profit_bps(): Int { return self.profitBps; }
    get fun get_accrued_profit_usd6(): Int { return self.accruedProfitUsd6; }
    get fun get_ton_usd6(): Int { return self.tonUsd6; }
    get fun get_blc_usd6(): Int { return self.blcUsd6; }
    get fun get_usdt_physical(): Int { return self.usdtPhysical; }
    get fun get_blc_physical(): Int { return self.blcPhysical; }
    get fun get_attestation_pubkey(): Int { return self.attestationPubkey; }
    get fun get_pending_pubkey(): Int { return self.pendingPubkey; }
    get fun get_pending_unlock_at(): Int { return self.pendingUnlockAt; }
    get fun get_rotate_delay_sec(): Int { return self.rotateDelaySec; }

    get fun get_balance(subjectId: String): Int {
        return self.balances.get(subjectKeyOf(subjectId)) != null ? self.balances.get(subjectKeyOf(subjectId))!! : 0;
    }

    get fun get_decision(decisionId: String): DecisionRecord? {
        return self.decisions.get(decisionKeyOf(decisionId));
    }

    get fun is_subject_paid(subjectId: String): Bool {
        return self.paidSubjects.get(subjectKeyOf(subjectId)) == true;
    }

    get fun preview_payout(decisionId: String): Int {
        let rec: DecisionRecord? = self.decisions.get(decisionKeyOf(decisionId));
        if (rec == null) { return 0; }
        let r: DecisionRecord = rec!!;
        if (r.appealed || r.paid) { return 0; }
        let figureBal: Int = self.balances.get(r.subjectKey) != null ? self.balances.get(r.subjectKey)!! : 0;
        return figureBal + minInt(self.kubyshkaBalance, r.cap);
    }
}
