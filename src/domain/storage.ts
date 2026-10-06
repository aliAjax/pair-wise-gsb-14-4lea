/**
 * 账本持久化：以“批次提交”为单位保证完整。
 *
 * 写入顺序：备份当前完整状态 → pending 标记 → 写新状态 → 清标记。
 * 任意时刻崩溃都能保证 backup 是最近一个完整批次：
 * 若写新状态前/中失败（如断网窗口崩溃、注入故障），重启时检测到 pending 标记，
 * 即从完整备份恢复；失败操作留在 outbox，恢复后重放（引擎幂等，不重复记差额）。
 */
import type { LedgerState } from "./types.js";

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const NS = "dfwlfront-9-ledger";

export const KEYS = {
  state: `${NS}:state`,
  backup: `${NS}:backup`,
  pending: `${NS}:pending`,
  outbox: `${NS}:outbox`,
} as const;

/** 待重放操作：保存失败时入队，恢复后按序重放 */
export interface OutboxOp {
  opId: string;
  kind: "receiveBatch" | "restoreOffline" | "arbitrate" | "closeShift" | "confirmReceipt";
  payload: unknown;
}

export interface LoadResult {
  state: LedgerState | null;
  recovered: boolean; // 是否检测到中断提交并从完整批次恢复
  outbox: OutboxOp[];
}

export function loadLedger(storage: StorageLike): LoadResult {
  let recovered = false;
  if (storage.getItem(KEYS.pending)) {
    // 上次提交未完成：state 可能撕裂，回退到完整备份
    const backup = storage.getItem(KEYS.backup);
    if (backup) {
      storage.setItem(KEYS.state, backup);
      recovered = true;
    }
    storage.removeItem(KEYS.pending);
  }
  const raw = storage.getItem(KEYS.state);
  let state: LedgerState | null = null;
  if (raw) {
    try {
      state = JSON.parse(raw) as LedgerState;
    } catch {
      state = null;
    }
  }
  return { state, recovered, outbox: loadOutbox(storage) };
}

/**
 * 提交一个完整批次的状态。
 * 先把当前完整状态存入备份，再标记提交开始、写新状态；
 * injectFailure=true 模拟标记后崩溃（保存失败演练），此时备份即最近完整批次。
 */
export function saveLedger(storage: StorageLike, state: LedgerState, commitId: string, injectFailure = false): void {
  const prev = storage.getItem(KEYS.state);
  if (prev) storage.setItem(KEYS.backup, prev);
  storage.setItem(KEYS.pending, commitId);
  if (injectFailure) {
    throw new Error(`保存失败：提交 ${commitId} 在写入前中断`);
  }
  storage.setItem(KEYS.state, JSON.stringify(state));
  storage.removeItem(KEYS.pending);
}

export function loadOutbox(storage: StorageLike): OutboxOp[] {
  try {
    return JSON.parse(storage.getItem(KEYS.outbox) ?? "[]") as OutboxOp[];
  } catch {
    return [];
  }
}

export function saveOutbox(storage: StorageLike, outbox: OutboxOp[]): void {
  storage.setItem(KEYS.outbox, JSON.stringify(outbox));
}
