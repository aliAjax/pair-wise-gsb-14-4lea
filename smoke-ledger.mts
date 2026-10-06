import { setActivePinia, createPinia } from "pinia";
import { useLedger } from "./src/stores/ledger";

// localStorage shim
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k)
};

setActivePinia(createPinia());
const ledger = useLedger();
const assert = (cond: boolean, msg: string) => {
  if (!cond) { console.error("FAIL:", msg); process.exit(1); }
  console.log("ok:", msg);
};

// 1. 先到者占生效位，后到同计划编号转待裁草稿
ledger.submitBatch({ planNo: "P-1", fuelId: "f-92", price: 7.8, effectiveAt: "2026-10-06T08:00", operator: "甲", source: "窗口" });
ledger.submitBatch({ planNo: "P-1", fuelId: "f-92", price: 7.9, effectiveAt: "2026-10-06T09:00", operator: "乙", source: "窗口" });
const p1 = ledger.batches.filter((b) => b.planNo === "P-1");
assert(p1.filter((b) => b.status === "生效").length === 1, "同计划编号仅一个生效位");
assert(p1.some((b) => b.status === "待裁草稿"), "后到内容转待裁草稿");
assert(ledger.fuels.find((f) => f.id === "f-92")!.price === 7.8, "先到者价格生效，未被旧值/后到值覆盖");

// 2. 换班小票：价格变动 → 未确认失效重算，已确认保留原差额
ledger.closeShift("S-1", "f-92", 1000); // diff = (7.8-7.62)*1000 = 180
const r1 = ledger.receipts.find((r) => r.shiftNo === "S-1")!;
assert(r1.diff === 180 && r1.status === "未确认", "小票差额按当前版本计算");
ledger.confirmReceipt(r1.id);
ledger.submitBatch({ planNo: "P-2", fuelId: "f-92", price: 8.0, effectiveAt: "2026-10-06T10:00", operator: "甲", source: "窗口" });
ledger.closeShift("S-2", "f-92", 500); // diff = (8.0-7.8)*500 = 100
ledger.submitBatch({ planNo: "P-3", fuelId: "f-92", price: 8.2, effectiveAt: "2026-10-06T11:00", operator: "甲", source: "窗口" });
const s2 = ledger.receipts.filter((r) => r.shiftNo === "S-2");
assert(s2.some((r) => r.status === "已失效"), "价格变动后未确认小票失效");
const s2new = s2.find((r) => r.status === "未确认")!;
assert(s2new.diff === Math.round((8.2 - 8.0) * 500 * 100) / 100, "未确认小票按新版本重算差额");
assert(ledger.receipts.find((r) => r.id === r1.id)!.diff === 180, "已确认小票保留原差额");

// 3. 断网补送：冲突两值保留，经理确认前不计售价
ledger.submitBatch({ id: "off-1", planNo: "P-2", fuelId: "f-92", price: 9.99, effectiveAt: "2026-10-06T10:00", operator: "丙", source: "断网补送" });
const off = ledger.batches.find((b) => b.id === "off-1")!;
assert(off.status === "待确认" && off.conflicts.length > 0, "断网包冲突转待确认且两值保留");
assert(ledger.fuels.find((f) => f.id === "f-92")!.price === 8.2, "经理确认前不计售价");
ledger.resolveConflicts("off-1", { price: "incoming", effectiveAt: "local", operator: "local" });
assert(ledger.batches.find((b) => b.id === "off-1")!.status === "待裁草稿", "冲突确认后转待裁草稿");
ledger.approveDraft("off-1");
assert(ledger.fuels.find((f) => f.id === "f-92")!.price === 9.99, "经理裁定后补送值生效");
assert(ledger.batches.filter((b) => b.planNo === "P-2" && b.status === "生效").length === 1, "旧生效批次已替换");

// 4. 重放不重复记差额
const before = ledger.receipts.length;
const diffBefore = ledger.pendingDiffTotal;
ledger.submitBatch({ id: "off-1", planNo: "P-2", fuelId: "f-92", price: 9.99, effectiveAt: "2026-10-06T10:00", operator: "丙", source: "断网补送" });
assert(ledger.receipts.length === before && ledger.pendingDiffTotal === diffBefore, "断网包重放被忽略，差额不重复计算");

// 5. 保存失败从完整批次恢复
const priceBefore = ledger.fuels.find((f) => f.id === "f-92")!.price;
ledger.simulateSaveFailureAndRecover();
assert(ledger.fuels.find((f) => f.id === "f-92")!.price === priceBefore, "主存档损坏后从完整批次恢复，数据一致");
assert(ledger.receipts.length === before, "恢复后小票不丢不重");

console.log("\n全部通过");
