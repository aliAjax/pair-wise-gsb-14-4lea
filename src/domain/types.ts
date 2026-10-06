/**
 * 油品调价账本领域模型。
 *
 * 四类食物串成一条链：
 *   调价批次(PriceBatch) --占位/仲裁--> 生效版本(PriceVersion)
 *   生效版本 --计价--> 换班小票(ShiftReceipt) --入账--> 账本流水(LedgerEntry)
 */

export type FuelId = string;

/** 油品 */
export interface Fuel {
  id: FuelId;
  name: string;
}

/** 批次状态：先到者占生效位，后到者转待裁草稿，仲裁淘汰的为已淘汰 */
export type BatchStatus = "effective" | "pending" | "superseded";

/** 可合并/可冲突的批次字段 */
export const MERGE_FIELDS = ["price", "effectiveAt", "operator"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

export const FIELD_LABELS: Record<MergeField, string> = {
  price: "挂牌价",
  effectiveAt: "生效时刻",
  operator: "操作员",
};

/**
 * 字段级冲突：断网包恢复时两值都保留，
 * 经理确认（resolved=true）前不参与售价与差额计算。
 */
export interface FieldConflict {
  field: MergeField;
  currentValue: string; // 账本现值（先到者/占位者）
  incomingValue: string; // 断网包/后到值
  resolved: boolean;
  chosenValue?: string;
}

/** 调价批次：一次调价意图的载体，计划编号 + 油品决定生效位归属 */
export interface PriceBatch {
  batchId: string;
  planNo: string; // 计划编号
  fuelId: FuelId;
  price: number; // 目标挂牌价（元/升）
  effectiveAt: string; // 生效时刻 ISO
  operator: string;
  origin: string; // 来源：站控窗口A/B、断网补送
  arrivalSeq: number; // 账本分配的到达顺序
  status: BatchStatus;
  conflicts: FieldConflict[];
  note?: string;
}

/** 生效版本：某油品价格链上的一环，由生效批次产生 */
export interface PriceVersion {
  versionId: string;
  fuelId: FuelId;
  seq: number;
  price: number;
  effectiveAt: string;
  batchId: string;
  active: boolean; // 当前执行版本
}

export type ReceiptStatus = "unconfirmed" | "confirmed" | "invalidated";

/** 换班小票：按班末时刻命中的价格版本计价，差额 = 价差 × 销量 */
export interface ShiftReceipt {
  receiptId: string;
  shiftNo: string; // 班次号
  fuelId: FuelId;
  shiftEndAt: string; // 班末时刻，决定适用版本
  volume: number; // 当班销量（升）
  versionId: string; // 计价所用版本
  unitPrice: number; // 计价单价快照
  prevPrice: number; // 上一版本价快照
  diff: number; // 差额（元）
  status: ReceiptStatus;
  postedKey: string; // 幂等键：班次|油品|版本|销量
  replacedBy?: string; // 失效后由哪张重算小票替代
}

export type EntryKind =
  | "batch-received" // 批次到达
  | "slot-occupied" // 先到者占生效位
  | "slot-deferred" // 后到者转待裁草稿
  | "merge-clean" // 断网包与账本一致，幂等跳过
  | "merge-conflict" // 字段冲突，两值保留
  | "arbitration" // 经理仲裁
  | "version-activated" // 新版本生效
  | "receipt-posted" // 小票差额入账
  | "receipt-invalidated" // 价格/生效时刻改动，未确认小票失效
  | "receipt-reposted" // 失效小票重算入账
  | "receipt-confirmed" // 小票确认，差额冻结
  | "commit-failed" // 保存失败
  | "recovered" // 从完整批次恢复
  | "replay-skipped"; // 重放命中幂等键，跳过重复记账

/** 账本流水：只追加，amount 为差额变动（元） */
export interface LedgerEntry {
  entryId: string;
  seq: number;
  kind: EntryKind;
  refId: string; // 关联对象 id
  fuelId?: FuelId;
  amount: number;
  memo: string;
  at: string;
}

/** 账本全量状态（可整体快照持久化） */
export interface LedgerState {
  fuels: Fuel[];
  batches: PriceBatch[];
  versions: PriceVersion[];
  receipts: ShiftReceipt[];
  entries: LedgerEntry[];
  arrivalCounter: number;
  versionCounter: number;
  entryCounter: number;
  postedKeys: string[]; // 已入账差额的幂等键，重放不重复记差额
}

/** 断网补送包 */
export interface OfflinePackage {
  packageId: string;
  batches: Array<{
    batchId: string;
    planNo: string;
    fuelId: FuelId;
    price: number;
    effectiveAt: string;
    operator: string;
  }>;
}
