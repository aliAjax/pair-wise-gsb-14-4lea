import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type BatchSource = "窗口" | "断网补送";
export type BatchStatus = "生效" | "待裁草稿" | "待确认" | "已驳回" | "已替换";
export type ReceiptStatus = "未确认" | "已确认" | "已失效";
export type ConflictField = "price" | "effectiveAt" | "operator";

export interface Fuel {
  id: string;
  name: string;
  price: number;
}

export interface FieldConflict {
  field: ConflictField;
  local: string | number;
  incoming: string | number;
}

/** 调价批次：窗口录入或断网补送，都先入账再占位 */
export interface Batch {
  id: string; // 批次ID，断网包自带，重放去重的依据
  planNo: string; // 计划编号，同一编号只占一个生效位
  fuelId: string;
  price: number;
  effectiveAt: string;
  operator: string;
  source: BatchSource;
  status: BatchStatus;
  conflicts: FieldConflict[]; // 冲突两值都保留，经理确认前不计售价和差额
  version: number | null; // 占位成功后对应的生效版本号
  createdAt: string;
}

/** 生效版本：油品价格的每一次生效落点 */
export interface PriceVersion {
  fuelId: string;
  version: number;
  price: number;
  effectiveAt: string;
  batchId: string;
  planNo: string;
  createdAt: string;
}

/** 换班小票：差额 = (本版价 - 上版价) × 班次销量 */
export interface Receipt {
  id: string;
  shiftNo: string;
  fuelId: string;
  volume: number;
  price: number;
  prevPrice: number;
  diff: number;
  version: number;
  status: ReceiptStatus;
  createdAt: string;
}

interface LedgerData {
  fuels: Fuel[];
  batches: Batch[];
  versions: PriceVersion[];
  receipts: Receipt[];
  processedIds: string[];
  events: string[];
}

export interface BatchInput {
  id?: string;
  planNo: string;
  fuelId: string;
  price: number;
  effectiveAt: string;
  operator: string;
  source: BatchSource;
}

export const CONFLICT_FIELD_LABELS: Record<ConflictField, string> = {
  price: "挂牌价",
  effectiveAt: "生效时刻",
  operator: "操作员"
};

const STORAGE_KEY = "dfwlfront-9-ledger";
const STAGING_KEY = `${STORAGE_KEY}:staging`;
const BACKUP_KEY = `${STORAGE_KEY}:backup`;

const round2 = (value: number) => Math.round(value * 100) / 100;

function checksum(body: string): string {
  let hash = 0;
  for (let i = 0; i < body.length; i += 1) {
    hash = (Math.imul(hash, 31) + body.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function seedData(): LedgerData {
  const now = Date.now();
  const iso = (offsetDays: number) => new Date(now + offsetDays * 86400000).toISOString();
  const fuels: Fuel[] = [
    { id: "f-92", name: "92号汽油", price: 7.62 },
    { id: "f-95", name: "95号汽油", price: 8.11 },
    { id: "f-98", name: "98号汽油", price: 8.63 },
    { id: "f-cy", name: "柴油", price: 7.18 }
  ];
  const versions: PriceVersion[] = [
    { fuelId: "f-92", version: 1, price: 7.55, effectiveAt: iso(-16).slice(0, 16), batchId: "seed-92-v1", planNo: "SEED-2026-001", createdAt: iso(-16) },
    { fuelId: "f-92", version: 2, price: 7.62, effectiveAt: iso(-7).slice(0, 16), batchId: "seed-92-v2", planNo: "SEED-2026-002", createdAt: iso(-7) },
    { fuelId: "f-95", version: 1, price: 8.11, effectiveAt: iso(-7).slice(0, 16), batchId: "seed-95-v1", planNo: "SEED-2026-002", createdAt: iso(-7) },
    { fuelId: "f-98", version: 1, price: 8.63, effectiveAt: iso(-7).slice(0, 16), batchId: "seed-98-v1", planNo: "SEED-2026-002", createdAt: iso(-7) },
    { fuelId: "f-cy", version: 1, price: 7.18, effectiveAt: iso(-7).slice(0, 16), batchId: "seed-cy-v1", planNo: "SEED-2026-002", createdAt: iso(-7) }
  ];
  const receipts: Receipt[] = [
    {
      id: "seed-rcpt-1",
      shiftNo: "20260630-早班",
      fuelId: "f-92",
      volume: 980,
      price: 7.62,
      prevPrice: 7.55,
      diff: round2((7.62 - 7.55) * 980),
      version: 2,
      status: "已确认",
      createdAt: iso(-6)
    },
    {
      id: "seed-rcpt-2",
      shiftNo: "20261006-早班",
      fuelId: "f-cy",
      volume: 1500,
      price: 7.18,
      prevPrice: 7.18,
      diff: 0,
      version: 1,
      status: "未确认",
      createdAt: iso(0)
    }
  ];
  return {
    fuels,
    batches: [],
    versions,
    receipts,
    processedIds: versions.map((v) => v.batchId),
    events: ["账本初始化完成，种子数据已入账"]
  };
}

export const useLedger = defineStore("ledger", () => {
  const fuels = ref<Fuel[]>([]);
  const batches = ref<Batch[]>([]);
  const versions = ref<PriceVersion[]>([]);
  const receipts = ref<Receipt[]>([]);
  const processedIds = ref<string[]>([]);
  const events = ref<string[]>([]);

  function log(message: string) {
    const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
    events.value = [`[${stamp}] ${message}`, ...events.value].slice(0, 40);
  }

  // ---------- 持久化：整批写入，上一个完整批次留作备份 ----------

  function snapshot(): LedgerData {
    return {
      fuels: fuels.value,
      batches: batches.value,
      versions: versions.value,
      receipts: receipts.value,
      processedIds: processedIds.value,
      events: events.value
    };
  }

  /**
   * 整批写入：先写暂存区，再把旧主存档留作备份，最后暂存转正。
   * 任何一步写坏，都还有一份完整批次可恢复。
   */
  function persist() {
    const body = JSON.stringify(snapshot());
    const envelope = JSON.stringify({ savedAt: new Date().toISOString(), seal: checksum(body), body });
    try {
      localStorage.setItem(STAGING_KEY, envelope);
      const previous = parseEnvelope(localStorage.getItem(STORAGE_KEY));
      if (previous) {
        localStorage.setItem(BACKUP_KEY, localStorage.getItem(STORAGE_KEY) as string);
      }
      localStorage.setItem(STORAGE_KEY, envelope);
    } catch {
      log("保存失败：已保留完整批次，恢复时以暂存区或备份为准");
    }
  }

  function parseEnvelope(raw: string | null): LedgerData | null {
    if (!raw) return null;
    try {
      const envelope = JSON.parse(raw) as { seal?: string; body?: string };
      if (!envelope.body || envelope.seal !== checksum(envelope.body)) return null;
      return JSON.parse(envelope.body) as LedgerData;
    } catch {
      return null;
    }
  }

  /** 载入账本：主存档损坏时依次从暂存区、上一个完整批次恢复 */
  function load(): boolean {
    const main = parseEnvelope(localStorage.getItem(STORAGE_KEY));
    const data =
      main ??
      parseEnvelope(localStorage.getItem(STAGING_KEY)) ??
      parseEnvelope(localStorage.getItem(BACKUP_KEY)) ??
      seedData();
    if (!main && localStorage.getItem(STORAGE_KEY)) {
      log("主存档损坏或保存不完整，已从完整批次恢复");
    }
    fuels.value = data.fuels;
    batches.value = data.batches;
    versions.value = data.versions;
    receipts.value = data.receipts;
    processedIds.value = data.processedIds;
    events.value = data.events;
    if (!main) persist(); // 用恢复出的完整批次修复主存档
    return true;
  }

  /** 演示用：模拟一次保存失败（主存档写坏），随后从完整批次恢复 */
  function simulateSaveFailureAndRecover() {
    localStorage.setItem(STORAGE_KEY, "{corrupted-partial-write");
    load();
    log("保存失败恢复演练完成：以完整批次为准，已入账批次重放不会重复记差额");
  }

  // ---------- 查询 ----------

  const fuelName = (fuelId: string) => fuels.value.find((f) => f.id === fuelId)?.name ?? fuelId;

  function currentVersion(fuelId: string): PriceVersion | undefined {
    return versions.value
      .filter((v) => v.fuelId === fuelId)
      .sort((a, b) => b.version - a.version)[0];
  }

  function previousVersion(fuelId: string, version: number): PriceVersion | undefined {
    return versions.value
      .filter((v) => v.fuelId === fuelId && v.version < version)
      .sort((a, b) => b.version - a.version)[0];
  }

  const priceBoard = computed(() =>
    fuels.value.map((fuel) => {
      const version = currentVersion(fuel.id);
      return { ...fuel, version: version?.version ?? 0, effectiveAt: version?.effectiveAt ?? "-" };
    })
  );

  const pendingDiffTotal = computed(() =>
    round2(receipts.value.filter((r) => r.status === "未确认").reduce((sum, r) => sum + r.diff, 0))
  );

  const confirmedDiffTotal = computed(() =>
    round2(receipts.value.filter((r) => r.status === "已确认").reduce((sum, r) => sum + r.diff, 0))
  );

  const awaitingCount = computed(
    () => batches.value.filter((b) => b.status === "待裁草稿" || b.status === "待确认").length
  );

  // ---------- 核心：占位、合并、生效 ----------

  /** 价格或生效时刻落账后：未确认小票失效重算，已确认保留原差额 */
  function recomputeReceipts(fuelId: string, version: PriceVersion) {
    const prev = previousVersion(fuelId, version.version);
    const prevPrice = prev?.price ?? version.price;
    const stale = receipts.value.filter((r) => r.fuelId === fuelId && r.status === "未确认");
    for (const old of stale) {
      old.status = "已失效";
      receipts.value.push({
        id: crypto.randomUUID(),
        shiftNo: old.shiftNo,
        fuelId,
        volume: old.volume,
        price: version.price,
        prevPrice,
        diff: round2((version.price - prevPrice) * old.volume),
        version: version.version,
        status: "未确认",
        createdAt: new Date().toISOString()
      });
    }
    if (stale.length > 0) {
      log(`${fuelName(fuelId)} 价格/生效时刻变动，${stale.length} 张未确认小票已失效重算，已确认小票保留原差额`);
    }
  }

  /** 批次占生效位：生成新生效版本并刷新牌价 */
  function applyBatch(batch: Batch) {
    const fuel = fuels.value.find((f) => f.id === batch.fuelId);
    if (!fuel) return;
    const versionNo = (currentVersion(batch.fuelId)?.version ?? 0) + 1;
    const version: PriceVersion = {
      fuelId: batch.fuelId,
      version: versionNo,
      price: batch.price,
      effectiveAt: batch.effectiveAt,
      batchId: batch.id,
      planNo: batch.planNo,
      createdAt: new Date().toISOString()
    };
    versions.value.push(version);
    fuel.price = batch.price;
    batch.status = "生效";
    batch.version = versionNo;
    // 同计划编号的旧生效批次让位
    for (const other of batches.value) {
      if (other.id !== batch.id && other.planNo === batch.planNo && other.status === "生效") {
        other.status = "已替换";
      }
    }
    recomputeReceipts(batch.fuelId, version);
    log(`计划 ${batch.planNo} 占生效位：${fuel.name} 挂牌价 ¥${batch.price}，版本 v${versionNo}`);
  }

  /** 先到者占生效位，后到内容转待裁草稿 */
  function occupySlotOrDraft(batch: Batch) {
    const slotTaken = batches.value.some((b) => b.planNo === batch.planNo && b.status === "生效");
    if (slotTaken) {
      batch.status = "待裁草稿";
      log(`计划 ${batch.planNo} 已有生效批次，后到内容转待裁草稿，等待经理裁定`);
    } else {
      applyBatch(batch);
    }
  }

  /**
   * 批次入账。
   * - 批次ID已入账 → 视为断网重放，直接忽略，差额不重复计算；
   * - 断网补送与同计划编号的既有批次按字段合并，冲突两值都保留，
   *   转入待确认，经理确认前不计售价和差额；
   * - 其余情况先到者占生效位，后到内容转待裁草稿。
   */
  function submitBatch(input: BatchInput): string {
    const id = input.id?.trim() || crypto.randomUUID();
    if (processedIds.value.includes(id)) {
      log(`批次 ${id} 已入账，断网重放忽略（不重复记差额）`);
      return "该批次已入账，重放已忽略";
    }
    const batch: Batch = {
      id,
      planNo: input.planNo.trim(),
      fuelId: input.fuelId,
      price: round2(Number(input.price)),
      effectiveAt: input.effectiveAt,
      operator: input.operator.trim(),
      source: input.source,
      status: "待裁草稿",
      conflicts: [],
      version: null,
      createdAt: new Date().toISOString()
    };

    if (batch.source === "断网补送") {
      const existing = batches.value.find(
        (b) => b.planNo === batch.planNo && b.id !== batch.id && b.status !== "已驳回" && b.status !== "已替换"
      );
      if (existing) {
        const conflicts: FieldConflict[] = [];
        (Object.keys(CONFLICT_FIELD_LABELS) as ConflictField[]).forEach((field) => {
          if (existing[field] !== batch[field]) {
            conflicts.push({ field, local: existing[field], incoming: batch[field] });
          }
        });
        if (conflicts.length > 0) {
          batch.conflicts = conflicts;
          batch.status = "待确认";
          batches.value.unshift(batch);
          processedIds.value.push(id);
          persist();
          log(`断网包与计划 ${batch.planNo} 既有内容冲突，两值都保留，经理确认前不计售价和差额`);
          return `与既有批次存在 ${conflicts.length} 处冲突，已转待确认`;
        }
        // 无冲突：内容与既有一致，直接并入，不再占位
        processedIds.value.push(id);
        persist();
        log(`断网包与计划 ${batch.planNo} 内容一致，按字段合并完成，无冲突`);
        return "断网包内容与既有一致，已合并";
      }
    }

    batches.value.unshift(batch);
    processedIds.value.push(id);
    occupySlotOrDraft(batch);
    persist();
    return batch.status === "生效" ? "已占生效位并刷新牌价" : "已转入待裁草稿";
  }

  /** 经理确认冲突字段：逐项选择保留本地值还是补送值，确认后转待裁草稿 */
  function resolveConflicts(batchId: string, resolutions: Record<ConflictField, "local" | "incoming">) {
    const batch = batches.value.find((b) => b.id === batchId);
    if (!batch || batch.status !== "待确认") return;
    for (const conflict of batch.conflicts) {
      const choice = resolutions[conflict.field] ?? "local";
      const value = choice === "incoming" ? conflict.incoming : conflict.local;
      if (conflict.field === "price") batch.price = Number(value);
      else if (conflict.field === "effectiveAt") batch.effectiveAt = String(value);
      else batch.operator = String(value);
    }
    batch.conflicts = [];
    batch.status = "待裁草稿";
    persist();
    log(`批次 ${batch.id} 冲突已由经理确认，转待裁草稿等待裁定`);
  }

  /** 经理裁定：待裁草稿批准生效（生成新版本）或驳回 */
  function approveDraft(batchId: string) {
    const batch = batches.value.find((b) => b.id === batchId);
    if (!batch || batch.status !== "待裁草稿") return;
    applyBatch(batch);
    persist();
  }

  function rejectBatch(batchId: string) {
    const batch = batches.value.find((b) => b.id === batchId);
    if (!batch || (batch.status !== "待裁草稿" && batch.status !== "待确认")) return;
    batch.status = "已驳回";
    batch.conflicts = [];
    persist();
    log(`批次 ${batch.id} 已驳回，不影响牌价与差额`);
  }

  // ---------- 换班小票 ----------

  /** 换班结账：按当前生效版本计价，差额 = (本版价 - 上版价) × 销量 */
  function closeShift(shiftNo: string, fuelId: string, volume: number): string {
    const version = currentVersion(fuelId);
    if (!version) return "该油品尚无生效版本";
    const prev = previousVersion(fuelId, version.version);
    const prevPrice = prev?.price ?? version.price;
    receipts.value.unshift({
      id: crypto.randomUUID(),
      shiftNo: shiftNo.trim(),
      fuelId,
      volume,
      price: version.price,
      prevPrice,
      diff: round2((version.price - prevPrice) * volume),
      version: version.version,
      status: "未确认",
      createdAt: new Date().toISOString()
    });
    persist();
    log(`班次 ${shiftNo} 已结账：${fuelName(fuelId)} ${volume}L，差额待确认`);
    return "小票已开具，差额待确认";
  }

  /** 确认小票：锁定差额，之后价格变动不再重算 */
  function confirmReceipt(receiptId: string) {
    const receipt = receipts.value.find((r) => r.id === receiptId);
    if (!receipt || receipt.status !== "未确认") return;
    receipt.status = "已确认";
    persist();
    log(`小票 ${receipt.shiftNo} 已确认，差额 ¥${receipt.diff} 锁定`);
  }

  load();

  return {
    fuels,
    batches,
    versions,
    receipts,
    events,
    fuelName,
    priceBoard,
    pendingDiffTotal,
    confirmedDiffTotal,
    awaitingCount,
    currentVersion,
    submitBatch,
    resolveConflicts,
    approveDraft,
    rejectBatch,
    closeShift,
    confirmReceipt,
    simulateSaveFailureAndRecover
  };
});
