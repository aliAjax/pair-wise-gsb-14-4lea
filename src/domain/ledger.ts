/**
 * 账本引擎：纯函数实现，直接改写传入的 state（调用方负责克隆与持久化）。
 *
 * 四条核心规则：
 * 1. 占位：计划编号 + 油品决定生效位，先到者占位生效，后到者转待裁草稿。
 * 2. 合并：断网包按字段合并，冲突两值都保留，经理确认前不计售价和差额。
 * 3. 恢复：批次是提交单位，保存失败可从完整批次恢复；差额入账带幂等键，重放不重复记。
 * 4. 重算：价格或生效时刻改动，未确认小票失效重算（冲回/重记成对，账不重复），
 *    已确认小票保留原差额。
 */
import {
  FIELD_LABELS,
  MERGE_FIELDS,
  type EntryKind,
  type FieldConflict,
  type Fuel,
  type FuelId,
  type LedgerEntry,
  type LedgerState,
  type MergeField,
  type OfflinePackage,
  type PriceBatch,
  type PriceVersion,
  type ShiftReceipt,
} from "./types.js";

export interface BatchInput {
  batchId?: string;
  planNo: string;
  fuelId: FuelId;
  price: number;
  effectiveAt: string;
  operator: string;
  origin: string;
  note?: string;
}

export interface ShiftInput {
  shiftNo: string;
  fuelId: FuelId;
  shiftEndAt: string;
  volume: number;
}

const slotKey = (planNo: string, fuelId: FuelId) => `${planNo}::${fuelId}`;

const round2 = (n: number) => Math.round(n * 100) / 100;

function log(
  state: LedgerState,
  kind: EntryKind,
  refId: string,
  memo: string,
  opts: { fuelId?: FuelId; amount?: number } = {},
): LedgerEntry {
  const entry: LedgerEntry = {
    entryId: `E${++state.entryCounter}`,
    seq: state.entryCounter,
    kind,
    refId,
    fuelId: opts.fuelId,
    amount: round2(opts.amount ?? 0),
    memo,
    at: new Date().toISOString(),
  };
  state.entries.push(entry);
  return entry;
}

function fuelName(state: LedgerState, fuelId: FuelId): string {
  return state.fuels.find((f) => f.id === fuelId)?.name ?? fuelId;
}

/** 油品当前执行版本 */
export function activeVersion(state: LedgerState, fuelId: FuelId): PriceVersion | undefined {
  return state.versions.find((v) => v.fuelId === fuelId && v.active);
}

/** 某时刻命中的版本：effectiveAt <= at 中最新者（同刻取序号大者）；没有则取最早版本兜底 */
export function versionAt(state: LedgerState, fuelId: FuelId, at: string): PriceVersion | undefined {
  const chain = state.versions
    .filter((v) => v.fuelId === fuelId)
    .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.seq - b.seq);
  if (chain.length === 0) return undefined;
  let hit = chain[0];
  for (const v of chain) {
    if (v.effectiveAt <= at) hit = v;
  }
  return hit;
}

/** 版本链上前一版本的价格（差额基准） */
function prevPriceOf(state: LedgerState, version: PriceVersion): number {
  const prev = state.versions
    .filter((v) => v.fuelId === version.fuelId && v.seq < version.seq)
    .sort((a, b) => b.seq - a.seq)[0];
  return prev ? prev.price : version.price;
}

/** 初始账本：四个油品 + 基准价版本（ genesis 批次占位） */
export function seedState(now = "2026-06-30T00:00:00.000Z"): LedgerState {
  const fuels: Fuel[] = [
    { id: "F92", name: "92号汽油" },
    { id: "F95", name: "95号汽油" },
    { id: "F98", name: "98号汽油" },
    { id: "FD", name: "柴油" },
  ];
  const basePrice: Record<string, number> = { F92: 7.62, F95: 8.11, F98: 8.96, FD: 7.18 };
  const state: LedgerState = {
    fuels,
    batches: [],
    versions: [],
    receipts: [],
    entries: [],
    arrivalCounter: 0,
    versionCounter: 0,
    entryCounter: 0,
    postedKeys: [],
  };
  for (const fuel of fuels) {
    const batch: PriceBatch = {
      batchId: `B-GEN-${fuel.id}`,
      planNo: "BASE-2026",
      fuelId: fuel.id,
      price: basePrice[fuel.id],
      effectiveAt: now,
      operator: "系统初始化",
      origin: "基准价",
      arrivalSeq: ++state.arrivalCounter,
      status: "effective",
      conflicts: [],
    };
    state.batches.push(batch);
    state.versions.push({
      versionId: `V${++state.versionCounter}`,
      fuelId: fuel.id,
      seq: state.versionCounter,
      price: batch.price,
      effectiveAt: batch.effectiveAt,
      batchId: batch.batchId,
      active: true,
    });
  }
  log(state, "slot-occupied", "BASE-2026", "基准价批次占位，四油品初始版本生效");
  return state;
}

/**
 * 接收调价批次（站控窗口/补送都会走到）。
 * 同 batchId 重放直接幂等返回；同计划编号已有生效批次时，后到内容转待裁草稿。
 */
export function receiveBatch(state: LedgerState, input: BatchInput): PriceBatch {
  const batchId = input.batchId ?? `B${state.arrivalCounter + 1}`;
  const dup = state.batches.find((b) => b.batchId === batchId);
  if (dup) {
    log(state, "replay-skipped", batchId, `批次 ${batchId} 已入账，重放跳过`);
    return dup;
  }
  const batch: PriceBatch = {
    batchId,
    planNo: input.planNo,
    fuelId: input.fuelId,
    price: input.price,
    effectiveAt: input.effectiveAt,
    operator: input.operator,
    origin: input.origin,
    arrivalSeq: ++state.arrivalCounter,
    status: "pending",
    conflicts: [],
    note: input.note,
  };
  state.batches.push(batch);
  log(
    state,
    "batch-received",
    batchId,
    `批次 ${batchId}（计划 ${batch.planNo} / ${fuelName(state, batch.fuelId)} / 到达序号 ${batch.arrivalSeq}）自${batch.origin}到达`,
    { fuelId: batch.fuelId },
  );
  const holder = state.batches.find(
    (b) => b.batchId !== batchId && b.status === "effective" && slotKey(b.planNo, b.fuelId) === slotKey(batch.planNo, batch.fuelId),
  );
  if (holder) {
    log(
      state,
      "slot-deferred",
      batchId,
      `计划 ${batch.planNo} 生效位已被 ${holder.batchId} 占用，${batchId} 转待裁草稿`,
      { fuelId: batch.fuelId },
    );
  } else {
    occupySlot(state, batch);
  }
  return batch;
}

/** 先到者占生效位 */
function occupySlot(state: LedgerState, batch: PriceBatch): void {
  batch.status = "effective";
  log(state, "slot-occupied", batch.batchId, `批次 ${batch.batchId} 先到，占计划 ${batch.planNo} 生效位`, {
    fuelId: batch.fuelId,
  });
  activateVersion(state, batch);
}

/**
 * 由生效批次激活版本。
 * 幂等：同批次且价格/生效时刻未变 → 复用原版本（重放安全）；
 * 值已变（仲裁改写）→ 生成新版本并触发小票重算。
 */
function activateVersion(state: LedgerState, batch: PriceBatch): PriceVersion {
  const existing = state.versions.find((v) => v.batchId === batch.batchId);
  if (existing && existing.price === batch.price && existing.effectiveAt === batch.effectiveAt) {
    return existing;
  }
  for (const v of state.versions) {
    if (v.fuelId === batch.fuelId && v.active) v.active = false;
  }
  const version: PriceVersion = {
    versionId: `V${++state.versionCounter}`,
    fuelId: batch.fuelId,
    seq: state.versionCounter,
    price: batch.price,
    effectiveAt: batch.effectiveAt,
    batchId: batch.batchId,
    active: true,
  };
  state.versions.push(version);
  log(
    state,
    "version-activated",
    version.versionId,
    `${fuelName(state, batch.fuelId)} 新版本 ${version.versionId} 生效：¥${version.price.toFixed(2)}，自 ${version.effectiveAt} 起（批次 ${batch.batchId}）`,
    { fuelId: batch.fuelId },
  );
  repriceReceipts(state, batch.fuelId);
  return version;
}

/**
 * 断网包恢复：按字段合并。
 * - 同 batchId 重发且字段一致 → 幂等跳过；
 * - 同计划编号已有生效批次 → 后到内容转待裁草稿，冲突两值挂在草稿上；
 * - 账本中无此计划 → 作为新批次正常接收。
 * 冲突在经理仲裁前不影响售价与差额。
 */
export function restoreOfflinePackage(state: LedgerState, pkg: OfflinePackage): void {
  for (const incoming of pkg.batches) {
    const sameBatch = state.batches.find((b) => b.batchId === incoming.batchId);
    if (sameBatch) {
      mergeFields(state, sameBatch, incoming);
      continue;
    }
    const holder = state.batches.find(
      (b) => b.status === "effective" && slotKey(b.planNo, b.fuelId) === slotKey(incoming.planNo, incoming.fuelId),
    );
    if (!holder) {
      receiveBatch(state, { ...incoming, origin: "断网补送" });
      continue;
    }
    // 后到者：转待裁草稿，再与占位者做字段级比对
    const draft = receiveBatch(state, { ...incoming, origin: "断网补送" });
    mergeFields(state, draft, incoming, holder);
  }
}

/** 字段级合并：一致则记 merge-clean，冲突则两值都保留 */
function mergeFields(
  state: LedgerState,
  target: PriceBatch,
  incoming: { price: number; effectiveAt: string; operator: string },
  holder?: PriceBatch,
): void {
  const base = holder ?? target; // 与占位者比对；无占位者时与自身（重发场景）比对
  const conflicts: FieldConflict[] = [];
  for (const field of MERGE_FIELDS) {
    const currentValue = String(base[field]);
    const incomingValue = String(incoming[field]);
    if (currentValue !== incomingValue) {
      conflicts.push({ field, currentValue, incomingValue, resolved: false });
    }
  }
  if (conflicts.length === 0) {
    log(state, "merge-clean", target.batchId, `断网包与账本字段一致，批次 ${target.batchId} 幂等跳过`, {
      fuelId: target.fuelId,
    });
    return;
  }
  // 两值都保留：并入目标批次的未决冲突（按字段去重，保留首见两值）
  for (const c of conflicts) {
    const known = target.conflicts.find((k) => k.field === c.field && !k.resolved);
    if (!known) target.conflicts.push(c);
  }
  const desc = conflicts.map((c) => `${FIELD_LABELS[c.field]}: 现值 ${c.currentValue} ↔ 来值 ${c.incomingValue}`).join("；");
  log(
    state,
    "merge-conflict",
    target.batchId,
    `断网包字段冲突，两值保留待经理确认（确认前不计售价和差额）：${desc}`,
    { fuelId: target.fuelId },
  );
}

/**
 * 经理仲裁。
 * decisions：逐字段选择 "current"（保留现值）或 "incoming"（采用来值）。
 * 待裁草稿：approve=true 解析后占位生效（原占位者淘汰，触发小票重算）；
 *           approve=false 保留现行，草稿淘汰。
 * 生效中批次的冲突：approve=true 按仲裁值改价/改生效时刻（触发重算）；
 *           approve=false 了结冲突，维持现行。
 */
export function arbitrate(
  state: LedgerState,
  batchId: string,
  decisions: Partial<Record<MergeField, "current" | "incoming">>,
  approve: boolean,
): void {
  const batch = state.batches.find((b) => b.batchId === batchId);
  if (!batch) return;
  const hasOpenConflicts = batch.conflicts.some((c) => !c.resolved);
  if (batch.status !== "pending" && !hasOpenConflicts) return;
  for (const c of batch.conflicts) {
    if (c.resolved) continue;
    const pick = decisions[c.field] ?? "current";
    c.resolved = true;
    c.chosenValue = pick === "incoming" ? c.incomingValue : c.currentValue;
  }
  if (!approve) {
    if (batch.status === "pending") {
      batch.status = "superseded";
      log(state, "arbitration", batchId, `经理保留现行，草稿 ${batchId} 淘汰`, { fuelId: batch.fuelId });
    } else {
      log(state, "arbitration", batchId, `经理了结冲突，批次 ${batchId} 维持现行值`, { fuelId: batch.fuelId });
    }
    return;
  }
  // 采用：把仲裁结果写回批次字段
  for (const c of batch.conflicts) {
    if (c.chosenValue === undefined) continue;
    if (c.field === "price") batch.price = Number(c.chosenValue);
    else if (c.field === "effectiveAt") batch.effectiveAt = c.chosenValue;
    else batch.operator = c.chosenValue;
  }
  if (batch.status === "pending") {
    const holder = state.batches.find(
      (b) => b.batchId !== batchId && b.status === "effective" && slotKey(b.planNo, b.fuelId) === slotKey(batch.planNo, batch.fuelId),
    );
    if (holder) {
      holder.status = "superseded";
      log(state, "arbitration", holder.batchId, `原占位批次 ${holder.batchId} 让位淘汰`, { fuelId: holder.fuelId });
    }
    batch.status = "effective";
  }
  log(state, "arbitration", batchId, `经理确认批次 ${batchId}：¥${batch.price.toFixed(2)} 自 ${batch.effectiveAt} 生效`, {
    fuelId: batch.fuelId,
  });
  activateVersion(state, batch);
}

/**
 * 价格或生效时刻改动后：未确认小票失效重算；已确认小票保留原差额。
 * 失效（冲回旧差额）与重记（记入新差额）成对出现，净额 = 新旧差额之差；
 * 重记幂等键已存在时只对冲不重复入键，保证重放不重复记差额。
 */
function repriceReceipts(state: LedgerState, fuelId: FuelId): void {
  const targets = state.receipts.filter((r) => r.fuelId === fuelId && r.status === "unconfirmed");
  for (const receipt of targets) {
    receipt.status = "invalidated";
    log(
      state,
      "receipt-invalidated",
      receipt.receiptId,
      `价格/生效时刻改动，未确认小票 ${receipt.receiptId}（班次 ${receipt.shiftNo}）失效，冲回差额 ¥${receipt.diff.toFixed(2)}`,
      { fuelId, amount: -receipt.diff },
    );
    const version = versionAt(state, fuelId, receipt.shiftEndAt);
    if (!version) continue;
    const prevPrice = prevPriceOf(state, version);
    const diff = round2((version.price - prevPrice) * receipt.volume);
    const postedKey = `${receipt.shiftNo}|${fuelId}|${version.versionId}|${receipt.volume}`;
    const replacement: ShiftReceipt = {
      receiptId: `R${state.receipts.length + 1}-${receipt.shiftNo}`,
      shiftNo: receipt.shiftNo,
      fuelId,
      shiftEndAt: receipt.shiftEndAt,
      volume: receipt.volume,
      versionId: version.versionId,
      unitPrice: version.price,
      prevPrice,
      diff,
      status: "unconfirmed",
      postedKey,
    };
    receipt.replacedBy = replacement.receiptId;
    state.receipts.push(replacement);
    const isNewKey = !state.postedKeys.includes(postedKey);
    if (isNewKey) state.postedKeys.push(postedKey);
    log(
      state,
      "receipt-reposted",
      replacement.receiptId,
      `小票重算：按版本 ${version.versionId} 重记差额 ¥${diff.toFixed(2)}（${postedKey}${isNewKey ? "" : "，键已入账，与冲回对冲"}）`,
      { fuelId, amount: diff },
    );
  }
}

/** 差额入账（幂等）：postedKey 已入账则记 replay-skipped 并跳过 */
function postDiff(state: LedgerState, receipt: ShiftReceipt, memo: string): boolean {
  if (state.postedKeys.includes(receipt.postedKey)) {
    log(state, "replay-skipped", receipt.receiptId, `差额幂等键 ${receipt.postedKey} 已入账，重放不重复记差额`, {
      fuelId: receipt.fuelId,
    });
    return false;
  }
  state.postedKeys.push(receipt.postedKey);
  log(state, "receipt-posted", receipt.receiptId, `${memo} ¥${receipt.diff.toFixed(2)}（${receipt.postedKey}）`, {
    fuelId: receipt.fuelId,
    amount: receipt.diff,
  });
  return true;
}

/** 交班记账：按班末时刻命中版本计价，差额 = (本版价 - 上一版价) × 销量 */
export function closeShift(state: LedgerState, input: ShiftInput): ShiftReceipt | undefined {
  const dup = state.receipts.find(
    (r) => r.shiftNo === input.shiftNo && r.fuelId === input.fuelId && r.volume === input.volume && r.status !== "invalidated",
  );
  if (dup) {
    log(state, "replay-skipped", dup.receiptId, `班次 ${input.shiftNo} 小票已存在，重放跳过`, { fuelId: input.fuelId });
    return dup;
  }
  const version = versionAt(state, input.fuelId, input.shiftEndAt);
  if (!version) return undefined;
  const prevPrice = prevPriceOf(state, version);
  const diff = round2((version.price - prevPrice) * input.volume);
  const receipt: ShiftReceipt = {
    receiptId: `R${state.receipts.length + 1}-${input.shiftNo}`,
    shiftNo: input.shiftNo,
    fuelId: input.fuelId,
    shiftEndAt: input.shiftEndAt,
    volume: input.volume,
    versionId: version.versionId,
    unitPrice: version.price,
    prevPrice,
    diff,
    status: "unconfirmed",
    postedKey: `${input.shiftNo}|${input.fuelId}|${version.versionId}|${input.volume}`,
  };
  state.receipts.push(receipt);
  postDiff(state, receipt, `班次 ${receipt.shiftNo} 交班，差额入账`);
  return receipt;
}

/** 经理确认小票：差额冻结，此后价格改动不再重算 */
export function confirmReceipt(state: LedgerState, receiptId: string): void {
  const receipt = state.receipts.find((r) => r.receiptId === receiptId);
  if (!receipt || receipt.status !== "unconfirmed") return;
  receipt.status = "confirmed";
  log(
    state,
    "receipt-confirmed",
    receipt.receiptId,
    `小票 ${receipt.receiptId} 确认，差额 ¥${receipt.diff.toFixed(2)} 冻结保留`,
    { fuelId: receipt.fuelId },
  );
}

/**
 * 当前入账差额合计：未失效且已入键的小票差额之和。
 * 与流水中（入账 + 重记 - 冲回）的净额恒等，可互相校验。
 */
export function postedDiffTotal(state: LedgerState, fuelId?: FuelId): number {
  return round2(
    state.receipts
      .filter((r) => r.status !== "invalidated")
      .filter((r) => !fuelId || r.fuelId === fuelId)
      .filter((r) => state.postedKeys.includes(r.postedKey))
      .reduce((acc, r) => acc + r.diff, 0),
  );
}

/** 流水侧差额净额（用于对账） */
export function journalDiffTotal(state: LedgerState, fuelId?: FuelId): number {
  const kinds: EntryKind[] = ["receipt-posted", "receipt-reposted", "receipt-invalidated"];
  return round2(
    state.entries
      .filter((e) => kinds.includes(e.kind))
      .filter((e) => !fuelId || e.fuelId === fuelId)
      .reduce((acc, e) => acc + e.amount, 0),
  );
}
