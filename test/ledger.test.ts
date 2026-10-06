/**
 * 账本引擎场景测试（node:test，编译后直接跑在 Node 上）。
 * 覆盖需求四条：占位、合并、恢复重放、失效重算。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeVersion,
  arbitrate,
  closeShift,
  confirmReceipt,
  journalDiffTotal,
  postedDiffTotal,
  receiveBatch,
  restoreOfflinePackage,
  seedState,
} from "../src/domain/ledger.js";
import { loadLedger, saveLedger, type StorageLike } from "../src/domain/storage.js";
import type { LedgerState } from "../src/domain/types.js";

/** 内存版 localStorage，用于持久化/恢复测试 */
function memStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const T = "2026-10-06T06:00:00.000Z";

test("占位：同计划编号先到者占生效位，后到者转待裁草稿；重放幂等", () => {
  const s = seedState();
  const a = receiveBatch(s, {
    batchId: "B-A",
    planNo: "PLAN-10",
    fuelId: "F92",
    price: 7.82,
    effectiveAt: T,
    operator: "站长",
    origin: "站控窗口A",
  });
  assert.equal(a.status, "effective");
  assert.equal(activeVersion(s, "F92")?.price, 7.82);

  const b = receiveBatch(s, {
    batchId: "B-B",
    planNo: "PLAN-10",
    fuelId: "F92",
    price: 7.55,
    effectiveAt: T,
    operator: "值班经理",
    origin: "站控窗口B",
  });
  assert.equal(b.status, "pending", "后到者必须转待裁草稿");
  assert.equal(activeVersion(s, "F92")?.price, 7.82, "先到者价格不被覆盖");
  assert.equal(s.versions.filter((v) => v.fuelId === "F92").length, 2, "待裁草稿不产生版本");

  // 同 batchId 重放：不新增批次、不新增版本
  const before = s.batches.length;
  const again = receiveBatch(s, {
    batchId: "B-B",
    planNo: "PLAN-10",
    fuelId: "F92",
    price: 7.55,
    effectiveAt: T,
    operator: "值班经理",
    origin: "站控窗口B",
  });
  assert.equal(again.batchId, "B-B");
  assert.equal(s.batches.length, before);
});

test("合并：断网包按字段合并，两值保留，经理确认前不计售价；仲裁后生效", () => {
  const s = seedState();
  receiveBatch(s, {
    batchId: "B-A",
    planNo: "PLAN-10",
    fuelId: "F92",
    price: 7.82,
    effectiveAt: T,
    operator: "站长",
    origin: "站控窗口A",
  });
  // 断网窗口的旧值补送（同计划、不同价/生效时刻/操作员）
  restoreOfflinePackage(s, {
    packageId: "PKG-1",
    batches: [
      {
        batchId: "B-OFF",
        planNo: "PLAN-10",
        fuelId: "F92",
        price: 7.55,
        effectiveAt: "2026-10-06T09:00:00.000Z",
        operator: "值班经理",
      },
    ],
  });
  const draft = s.batches.find((b) => b.batchId === "B-OFF");
  assert.equal(draft?.status, "pending");
  const priceConflict = draft?.conflicts.find((c) => c.field === "price");
  assert.deepEqual(
    priceConflict && [priceConflict.currentValue, priceConflict.incomingValue],
    ["7.82", "7.55"],
    "冲突两值都要保留",
  );
  assert.ok(draft?.conflicts.some((c) => c.field === "effectiveAt"));
  assert.equal(activeVersion(s, "F92")?.price, 7.82, "经理确认前不计售价");

  // 字段一致的重复补送 → 幂等
  const entriesBefore = s.entries.length;
  restoreOfflinePackage(s, {
    packageId: "PKG-1-retry",
    batches: [{ batchId: "B-A", planNo: "PLAN-10", fuelId: "F92", price: 7.82, effectiveAt: T, operator: "站长" }],
  });
  assert.ok(s.entries.slice(entriesBefore).some((e) => e.kind === "merge-clean"));
  assert.equal(activeVersion(s, "F92")?.price, 7.82);

  // 经理采用草稿来值 → 新价生效，原占位者淘汰
  arbitrate(s, "B-OFF", { price: "incoming", effectiveAt: "incoming", operator: "incoming" }, true);
  assert.equal(activeVersion(s, "F92")?.price, 7.55);
  assert.equal(activeVersion(s, "F92")?.effectiveAt, "2026-10-06T09:00:00.000Z");
  assert.equal(s.batches.find((b) => b.batchId === "B-A")?.status, "superseded");
  assert.equal(s.batches.find((b) => b.batchId === "B-OFF")?.status, "effective");
});

test("仲裁拒绝：保留现行，草稿淘汰，售价不变", () => {
  const s = seedState();
  receiveBatch(s, {
    batchId: "B-1",
    planNo: "PLAN-20",
    fuelId: "FD",
    price: 7.3,
    effectiveAt: T,
    operator: "站长",
    origin: "站控窗口A",
  });
  receiveBatch(s, {
    batchId: "B-2",
    planNo: "PLAN-20",
    fuelId: "FD",
    price: 7.1,
    effectiveAt: T,
    operator: "值班经理",
    origin: "站控窗口B",
  });
  arbitrate(s, "B-2", {}, false);
  assert.equal(s.batches.find((b) => b.batchId === "B-2")?.status, "superseded");
  assert.equal(activeVersion(s, "FD")?.price, 7.3);
});

test("恢复：保存失败从完整批次恢复，重放不重复记差额", () => {
  const storage = memStorage();
  const s0 = seedState();
  saveLedger(storage, s0, "boot");

  // 提交1（成功）：调价批次
  const s1 = structuredClone(s0);
  receiveBatch(s1, {
    batchId: "B-1",
    planNo: "PLAN-10",
    fuelId: "F92",
    price: 7.9,
    effectiveAt: T,
    operator: "站长",
    origin: "站控窗口A",
  });
  saveLedger(storage, s1, "c1");

  // 提交2（注入失败）：交班记账
  const s2 = structuredClone(s1);
  closeShift(s2, { shiftNo: "S1", fuelId: "F92", shiftEndAt: "2026-10-06T10:00:00.000Z", volume: 1000 });
  assert.throws(() => saveLedger(storage, s2, "c2", true));

  // 恢复：检测到中断提交，回退完整批次
  const loaded = loadLedger(storage);
  assert.equal(loaded.recovered, true);
  const recovered = loaded.state as LedgerState;
  assert.equal(postedDiffTotal(recovered), postedDiffTotal(s1), "恢复后差额与最后完整批次一致");
  assert.equal(activeVersion(recovered, "F92")?.price, 7.9);

  // 重放失败的操作：差额入账一次
  const s3 = structuredClone(recovered);
  closeShift(s3, { shiftNo: "S1", fuelId: "F92", shiftEndAt: "2026-10-06T10:00:00.000Z", volume: 1000 });
  saveLedger(storage, s3, "c3");
  assert.equal(postedDiffTotal(s3), 280, "(7.9-7.62)×1000 = 280");

  // 重复重放（补送重试）：不重复记差额
  const s4 = structuredClone(s3);
  closeShift(s4, { shiftNo: "S1", fuelId: "F92", shiftEndAt: "2026-10-06T10:00:00.000Z", volume: 1000 });
  assert.equal(postedDiffTotal(s4), 280, "重放不重复记差额");
  assert.ok(s4.entries.some((e) => e.kind === "replay-skipped"));
  assert.equal(journalDiffTotal(s4), postedDiffTotal(s4), "流水净额与入账合计恒等");
});

test("重算：价格/生效时刻改动，未确认小票失效重算，已确认保留原差额", () => {
  const s = seedState();
  receiveBatch(s, {
    batchId: "B-1",
    planNo: "PLAN-10",
    fuelId: "F92",
    price: 7.9,
    effectiveAt: T,
    operator: "站长",
    origin: "站控窗口A",
  });
  const r1 = closeShift(s, { shiftNo: "S1", fuelId: "F92", shiftEndAt: "2026-10-06T08:00:00.000Z", volume: 1000 });
  const r2 = closeShift(s, { shiftNo: "S2", fuelId: "F92", shiftEndAt: "2026-10-06T09:00:00.000Z", volume: 500 });
  assert.equal(r1?.diff, 280);
  assert.equal(r2?.diff, 140);
  confirmReceipt(s, r2!.receiptId);

  // 价格+生效时刻改动
  receiveBatch(s, {
    batchId: "B-2",
    planNo: "PLAN-11",
    fuelId: "F92",
    price: 8.1,
    effectiveAt: "2026-10-06T07:00:00.000Z",
    operator: "站长",
    origin: "站控窗口A",
  });
  const r1After = s.receipts.find((r) => r.receiptId === r1!.receiptId);
  assert.equal(r1After?.status, "invalidated", "未确认小票失效");
  const replacement = s.receipts.find((r) => r.receiptId === r1After?.replacedBy);
  assert.equal(replacement?.status, "unconfirmed");
  assert.equal(replacement?.diff, 200, "按新版本重算：(8.1-7.9)×1000");
  const r2After = s.receipts.find((r) => r.receiptId === r2!.receiptId);
  assert.equal(r2After?.status, "confirmed", "已确认小票不动");
  assert.equal(r2After?.diff, 140, "已确认保留原差额");
  assert.equal(postedDiffTotal(s), 340);
  assert.equal(journalDiffTotal(s), 340, "冲回/重记成对，流水净额与入账一致");

  // 生效时刻改到所有班次之后：适用版本不变，重记与冲回对冲，差额不重复
  receiveBatch(s, {
    batchId: "B-3",
    planNo: "PLAN-12",
    fuelId: "F92",
    price: 8.1,
    effectiveAt: "2027-01-01T00:00:00.000Z",
    operator: "站长",
    origin: "站控窗口A",
  });
  assert.equal(postedDiffTotal(s), 340, "同键重记不重复计差额");
  assert.equal(journalDiffTotal(s), postedDiffTotal(s));
  const s1Receipts = s.receipts.filter((r) => r.shiftNo === "S1");
  assert.equal(s1Receipts.filter((r) => r.status === "invalidated").length, 2);
  assert.equal(s1Receipts.filter((r) => r.status === "unconfirmed").length, 1);
});
