/**
 * 账本 Store：引擎纯函数 + 原子提交 + 失败恢复重放。
 *
 * commit：克隆 → 引擎改写 → 原子保存；保存失败则账本保持完整旧状态，
 * 操作进 outbox。recoverAndReplay：从完整批次恢复后按序重放 outbox，
 * 引擎幂等（batchId 去重 + 差额幂等键），重放不重复记差额。
 */
import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  arbitrate,
  closeShift,
  confirmReceipt,
  postedDiffTotal,
  receiveBatch,
  restoreOfflinePackage,
  seedState,
  type BatchInput,
  type ShiftInput,
} from "../domain/ledger";
import { KEYS, loadLedger, saveLedger, saveOutbox, type OutboxOp } from "../domain/storage";
import type { LedgerState, MergeField, OfflinePackage } from "../domain/types";

function applyOp(draft: LedgerState, op: OutboxOp): void {
  switch (op.kind) {
    case "receiveBatch":
      receiveBatch(draft, op.payload as BatchInput);
      break;
    case "restoreOffline":
      restoreOfflinePackage(draft, op.payload as OfflinePackage);
      break;
    case "arbitrate": {
      const p = op.payload as { batchId: string; decisions: Partial<Record<MergeField, "current" | "incoming">>; approve: boolean };
      arbitrate(draft, p.batchId, p.decisions, p.approve);
      break;
    }
    case "closeShift":
      closeShift(draft, op.payload as ShiftInput);
      break;
    case "confirmReceipt":
      confirmReceipt(draft, (op.payload as { receiptId: string }).receiptId);
      break;
  }
}

export const useLedgerStore = defineStore("ledger", () => {
  const boot = loadLedger(localStorage);
  const state = ref<LedgerState>(boot.state ?? seedState());
  const outbox = ref<OutboxOp[]>(boot.outbox);
  const failNextSave = ref(false);
  const notice = ref(boot.recovered ? "检测到中断提交，已从完整批次恢复" : "");
  const replayedAtBoot = ref(false);

  const fuels = computed(() => state.value.fuels);
  const batches = computed(() => [...state.value.batches].sort((a, b) => b.arrivalSeq - a.arrivalSeq));
  const pendingBatches = computed(() =>
    state.value.batches.filter((b) => b.status === "pending" || b.conflicts.some((c) => !c.resolved)),
  );
  const receipts = computed(() => [...state.value.receipts].reverse());
  const entries = computed(() => [...state.value.entries].reverse());
  const diffTotal = computed(() => postedDiffTotal(state.value));
  const unconfirmedCount = computed(() => state.value.receipts.filter((r) => r.status === "unconfirmed").length);

  function fuelName(fuelId: string): string {
    return state.value.fuels.find((f) => f.id === fuelId)?.name ?? fuelId;
  }

  function activePrice(fuelId: string): string {
    const v = state.value.versions.find((v) => v.fuelId === fuelId && v.active);
    return v ? `¥${v.price.toFixed(2)}` : "—";
  }

  function versionsOf(fuelId: string) {
    return state.value.versions.filter((v) => v.fuelId === fuelId).sort((a, b) => b.seq - a.seq);
  }

  /** 原子提交一笔操作；失败则入待重放队列，账本保持完整旧状态 */
  function commit(kind: OutboxOp["kind"], payload: unknown): boolean {
    const op: OutboxOp = { opId: crypto.randomUUID(), kind, payload };
    const draft = structuredClone(state.value);
    applyOp(draft, op);
    try {
      saveLedger(localStorage, draft, op.opId, failNextSave.value);
      state.value = draft;
      notice.value = "";
      return true;
    } catch {
      outbox.value.push(op);
      saveOutbox(localStorage, outbox.value);
      notice.value = `保存失败：操作已入待重放队列（${outbox.value.length} 笔），账本保持完整旧批次，点“恢复重放”继续`;
      return false;
    } finally {
      failNextSave.value = false;
    }
  }

  /** 从完整批次恢复，并重放待办操作（幂等，不重复记差额） */
  function recoverAndReplay(): void {
    const loaded = loadLedger(localStorage);
    const base = loaded.state ?? seedState();
    const replayed = structuredClone(base);
    const queue = [...outbox.value];
    for (const op of queue) applyOp(replayed, op);
    try {
      saveLedger(localStorage, replayed, `recover-${Date.now()}`);
      state.value = replayed;
      outbox.value = [];
      saveOutbox(localStorage, []);
      notice.value = loaded.recovered
        ? `检测到中断提交，已从完整批次恢复并重放 ${queue.length} 笔操作（差额不重复记账）`
        : queue.length > 0
          ? `已重放 ${queue.length} 笔待办操作，差额不重复记账`
          : "账本完整，无需恢复";
    } catch {
      notice.value = "恢复时保存再次失败，待办操作保留在队列中";
    }
  }

  // 启动时：若有中断提交或积压待办，自动恢复重放
  if (boot.recovered || boot.outbox.length > 0) {
    recoverAndReplay();
    replayedAtBoot.value = true;
  }

  function resetAll(): void {
    for (const key of Object.values(KEYS)) localStorage.removeItem(key);
    state.value = seedState();
    outbox.value = [];
    notice.value = "已重置为基准账本";
  }

  return {
    state,
    outbox,
    failNextSave,
    notice,
    replayedAtBoot,
    fuels,
    batches,
    pendingBatches,
    receipts,
    entries,
    diffTotal,
    unconfirmedCount,
    fuelName,
    activePrice,
    versionsOf,
    commit,
    recoverAndReplay,
    resetAll,
  };
});
