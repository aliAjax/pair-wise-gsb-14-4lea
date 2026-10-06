<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useLedgerStore } from "./stores/ledger";
import { FIELD_LABELS, type MergeField, type PriceBatch } from "./domain/types";

const store = useLedgerStore();

const KIND_LABELS: Record<string, string> = {
  "batch-received": "批次到达",
  "slot-occupied": "占位生效",
  "slot-deferred": "转待裁",
  "merge-clean": "合并一致",
  "merge-conflict": "字段冲突",
  arbitration: "经理仲裁",
  "version-activated": "版本生效",
  "receipt-posted": "差额入账",
  "receipt-invalidated": "小票失效",
  "receipt-reposted": "差额重记",
  "receipt-confirmed": "小票确认",
  "commit-failed": "保存失败",
  recovered: "批次恢复",
  "replay-skipped": "重放跳过",
};

const BATCH_STATUS: Record<string, string> = {
  effective: "生效位",
  pending: "待裁草稿",
  superseded: "已淘汰",
};

const RECEIPT_STATUS: Record<string, string> = {
  unconfirmed: "未确认",
  confirmed: "已确认",
  invalidated: "已失效",
};

const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const toIso = (local: string) => new Date(local).toISOString();
const fmtTime = (iso: string) => new Date(iso).toLocaleString("zh-CN", { hour12: false });
const fmtMoney = (n: number) => `¥${n.toFixed(2)}`;

// ---------- 调价批次表单 ----------
const batchForm = reactive({
  planNo: "PLAN-101",
  fuelId: "F92",
  price: 7.82,
  effectiveAt: toLocalInput(new Date()),
  operator: "站长",
  origin: "站控窗口A",
});

function submitBatch() {
  store.commit("receiveBatch", {
    planNo: batchForm.planNo.trim(),
    fuelId: batchForm.fuelId,
    price: Number(batchForm.price),
    effectiveAt: toIso(batchForm.effectiveAt),
    operator: batchForm.operator.trim(),
    origin: batchForm.origin,
  });
}

// ---------- 断网补送表单 ----------
const offlineForm = reactive({
  planNo: "PLAN-101",
  fuelId: "F92",
  price: 7.55,
  effectiveAt: toLocalInput(new Date()),
  operator: "值班经理(断网窗口)",
});

const effectiveBatches = computed(() => store.state.batches.filter((b) => b.status === "effective"));

function prefillOffline(batchId: string) {
  const holder = effectiveBatches.value.find((b) => b.batchId === batchId);
  if (!holder) return;
  offlineForm.planNo = holder.planNo;
  offlineForm.fuelId = holder.fuelId;
  offlineForm.price = Math.max(0.01, Math.round((holder.price - 0.27) * 100) / 100);
  offlineForm.effectiveAt = toLocalInput(new Date());
}

function submitOffline() {
  store.commit("restoreOffline", {
    packageId: `PKG-${Date.now()}`,
    batches: [
      {
        batchId: `OFF-${Date.now()}`,
        planNo: offlineForm.planNo.trim(),
        fuelId: offlineForm.fuelId,
        price: Number(offlineForm.price),
        effectiveAt: toIso(offlineForm.effectiveAt),
        operator: offlineForm.operator.trim(),
      },
    ],
  });
}

// ---------- 交班记账表单 ----------
const shiftForm = reactive({
  shiftNo: "S1",
  fuelId: "F92",
  shiftEndAt: toLocalInput(new Date()),
  volume: 1000,
});

function submitShift() {
  store.commit("closeShift", {
    shiftNo: shiftForm.shiftNo.trim(),
    fuelId: shiftForm.fuelId,
    shiftEndAt: toIso(shiftForm.shiftEndAt),
    volume: Number(shiftForm.volume),
  });
  const next = Number(shiftForm.shiftNo.replace(/\D/g, "")) || 0;
  shiftForm.shiftNo = `S${next + 1}`;
}

// ---------- 仲裁 ----------
const decisions = reactive<Record<string, Partial<Record<MergeField, "current" | "incoming">>>>({});

function decisionFor(batch: PriceBatch, field: MergeField): "current" | "incoming" {
  return decisions[batch.batchId]?.[field] ?? "current";
}

function setDecision(batch: PriceBatch, field: MergeField, value: "current" | "incoming") {
  decisions[batch.batchId] = { ...decisions[batch.batchId], [field]: value };
}

function openConflicts(batch: PriceBatch) {
  return batch.conflicts.filter((c) => !c.resolved);
}

function approve(batch: PriceBatch) {
  store.commit("arbitrate", { batchId: batch.batchId, decisions: decisions[batch.batchId] ?? {}, approve: true });
}

function reject(batch: PriceBatch) {
  store.commit("arbitrate", { batchId: batch.batchId, decisions: {}, approve: false });
}

// ---------- 展示辅助 ----------
const metrics = computed(() => [
  { label: "油品数", value: store.fuels.length },
  { label: "待裁草稿", value: store.pendingBatches.length },
  { label: "未确认小票", value: store.unconfirmedCount },
  { label: "入账差额合计", value: fmtMoney(store.diffTotal) },
]);

const journalKinds = new Set(["receipt-posted", "receipt-reposted", "receipt-invalidated"]);
const showAmount = (kind: string) => journalKinds.has(kind);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 调价账本</p>
          <h1>油品价格维护</h1>
          <p class="subtitle">
            油品、调价批次、生效版本、换班小票接成一本账：同计划编号先到者占生效位、后到转待裁草稿；
            断网包按字段合并、冲突两值保留，经理确认前不计售价和差额；保存失败从完整批次恢复、重放不重复记差额；
            价格或生效时刻改动，未确认小票失效重算、已确认保留原差额。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">TypeScript</span>
          <span class="tag">Pinia</span>
          <span class="tag">localStorage 原子提交</span>
        </div>
      </header>

      <p v-if="store.notice" class="notice">{{ store.notice }}</p>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <section class="workspace">
        <!-- 左列：操作台 -->
        <div class="col">
          <form class="panel" @submit.prevent="submitBatch">
            <h2>调价批次（站控窗口）</h2>
            <div class="form-grid">
              <label>
                计划编号
                <input v-model="batchForm.planNo" required placeholder="如 PLAN-101" />
              </label>
              <label>
                油品
                <select v-model="batchForm.fuelId">
                  <option v-for="f in store.fuels" :key="f.id" :value="f.id">{{ f.name }}（现行 {{ store.activePrice(f.id) }}）</option>
                </select>
              </label>
              <label>
                挂牌价（元/升）
                <input v-model="batchForm.price" type="number" step="0.01" min="0.01" required />
              </label>
              <label>
                生效时刻
                <input v-model="batchForm.effectiveAt" type="datetime-local" required />
              </label>
              <label>
                操作员
                <input v-model="batchForm.operator" required />
              </label>
              <label>
                来源窗口
                <select v-model="batchForm.origin">
                  <option>站控窗口A</option>
                  <option>站控窗口B</option>
                </select>
              </label>
              <button type="submit">提交批次（先到者占生效位）</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitOffline">
            <h2>断网补送恢复</h2>
            <div class="form-grid">
              <label>
                对照生效批次（预填旧值）
                <select @change="prefillOffline(($event.target as HTMLSelectElement).value)">
                  <option value="">手动填写</option>
                  <option v-for="b in effectiveBatches" :key="b.batchId" :value="b.batchId">
                    {{ b.planNo }} / {{ store.fuelName(b.fuelId) }} / 现行 ¥{{ b.price.toFixed(2) }}
                  </option>
                </select>
              </label>
              <label>
                计划编号
                <input v-model="offlineForm.planNo" required />
              </label>
              <label>
                油品
                <select v-model="offlineForm.fuelId">
                  <option v-for="f in store.fuels" :key="f.id" :value="f.id">{{ f.name }}</option>
                </select>
              </label>
              <label>
                补送挂牌价（断网期间旧值）
                <input v-model="offlineForm.price" type="number" step="0.01" min="0.01" required />
              </label>
              <label>
                生效时刻
                <input v-model="offlineForm.effectiveAt" type="datetime-local" required />
              </label>
              <label>
                操作员
                <input v-model="offlineForm.operator" required />
              </label>
              <button type="submit">恢复断网包（按字段合并）</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="submitShift">
            <h2>交班记账</h2>
            <div class="form-grid">
              <label>
                班次号
                <input v-model="shiftForm.shiftNo" required />
              </label>
              <label>
                油品
                <select v-model="shiftForm.fuelId">
                  <option v-for="f in store.fuels" :key="f.id" :value="f.id">{{ f.name }}</option>
                </select>
              </label>
              <label>
                班末时刻
                <input v-model="shiftForm.shiftEndAt" type="datetime-local" required />
              </label>
              <label>
                当班销量（升）
                <input v-model="shiftForm.volume" type="number" min="1" step="1" required />
              </label>
              <button type="submit">交班入账（差额 = 价差 × 销量）</button>
            </div>
          </form>

          <section class="panel">
            <h2>保存失败演练</h2>
            <div class="form-grid">
              <label class="check">
                <input v-model="store.failNextSave" type="checkbox" />
                下次提交注入保存失败（操作进待重放队列）
              </label>
              <button type="button" class="secondary" @click="store.recoverAndReplay()">
                从完整批次恢复并重放（待办 {{ store.outbox.length }} 笔）
              </button>
              <button type="button" class="danger" @click="store.resetAll()">重置账本</button>
            </div>
          </section>
        </div>

        <!-- 中列：批次与仲裁 -->
        <section class="list-panel">
          <div class="toolbar">
            <h2>调价批次</h2>
            <span class="hint">计划编号 + 油品 = 生效位</span>
          </div>
          <div class="record-grid">
            <div v-if="store.batches.length === 0" class="empty">暂无批次</div>
            <article v-for="b in store.batches" :key="b.batchId" class="record" :class="`st-${b.status}`">
              <div class="record-head">
                <p class="record-title">{{ b.planNo }} / {{ store.fuelName(b.fuelId) }} / ¥{{ b.price.toFixed(2) }}</p>
                <span class="status" :class="`badge-${b.status}`">{{ BATCH_STATUS[b.status] }}</span>
              </div>
              <div class="details">
                <span>批次号: {{ b.batchId }}</span>
                <span>到达序号: {{ b.arrivalSeq }}</span>
                <span>生效时刻: {{ fmtTime(b.effectiveAt) }}</span>
                <span>操作员: {{ b.operator }}</span>
                <span>来源: {{ b.origin }}</span>
              </div>

              <div v-if="openConflicts(b).length > 0" class="conflicts">
                <p class="conflict-title">字段冲突（两值保留，经理确认前不计售价和差额）</p>
                <div v-for="c in openConflicts(b)" :key="c.field" class="conflict">
                  <span class="conflict-field">{{ FIELD_LABELS[c.field] }}</span>
                  <label class="pick">
                    <input
                      type="radio"
                      :name="`${b.batchId}-${c.field}`"
                      :checked="decisionFor(b, c.field) === 'current'"
                      @change="setDecision(b, c.field, 'current')"
                    />
                    现值 {{ c.currentValue }}
                  </label>
                  <label class="pick">
                    <input
                      type="radio"
                      :name="`${b.batchId}-${c.field}`"
                      :checked="decisionFor(b, c.field) === 'incoming'"
                      @change="setDecision(b, c.field, 'incoming')"
                    />
                    来值 {{ c.incomingValue }}
                  </label>
                </div>
              </div>

              <div v-if="b.status === 'pending' || openConflicts(b).length > 0" class="actions">
                <button type="button" @click="approve(b)">经理确认：采用所选值生效</button>
                <button type="button" class="secondary" @click="reject(b)">
                  {{ b.status === "pending" ? "保留现行，淘汰草稿" : "了结冲突，维持现行" }}
                </button>
              </div>
            </article>
          </div>
        </section>

        <!-- 右列：版本链 + 换班小票 -->
        <div class="col">
          <section class="list-panel">
            <div class="toolbar"><h2>生效版本链</h2></div>
            <div v-for="f in store.fuels" :key="f.id" class="fuel-block">
              <p class="fuel-head">{{ f.name }}<strong>{{ store.activePrice(f.id) }}</strong></p>
              <div v-for="v in store.versionsOf(f.id)" :key="v.versionId" class="version" :class="{ active: v.active }">
                <span class="status" :class="v.active ? 'badge-effective' : 'badge-superseded'">{{ v.active ? "现行" : "历史" }}</span>
                <span>{{ v.versionId }}</span>
                <span>¥{{ v.price.toFixed(2) }}</span>
                <span>{{ fmtTime(v.effectiveAt) }} 起</span>
                <span class="hint">{{ v.batchId }}</span>
              </div>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar">
              <h2>换班小票</h2>
              <span class="hint">未确认小票随价格/生效时刻改动失效重算</span>
            </div>
            <div class="record-grid">
              <div v-if="store.receipts.length === 0" class="empty">暂无小票</div>
              <article v-for="r in store.receipts" :key="r.receiptId" class="record">
                <div class="record-head">
                  <p class="record-title">班次 {{ r.shiftNo }} / {{ store.fuelName(r.fuelId) }}</p>
                  <span class="status" :class="`badge-${r.status}`">{{ RECEIPT_STATUS[r.status] }}</span>
                </div>
                <div class="details">
                  <span>小票号: {{ r.receiptId }}</span>
                  <span>计价版本: {{ r.versionId }}</span>
                  <span>单价: ¥{{ r.unitPrice.toFixed(2) }}（上版 ¥{{ r.prevPrice.toFixed(2) }}）</span>
                  <span>销量: {{ r.volume }} 升</span>
                  <span>差额: <strong>{{ fmtMoney(r.diff) }}</strong></span>
                  <span>班末: {{ fmtTime(r.shiftEndAt) }}</span>
                </div>
                <p class="note">幂等键 {{ r.postedKey }}<template v-if="r.replacedBy">；已由 {{ r.replacedBy }} 重算替代</template></p>
                <div v-if="r.status === 'unconfirmed'" class="actions">
                  <button type="button" class="secondary" @click="store.commit('confirmReceipt', { receiptId: r.receiptId })">
                    经理确认（冻结差额）
                  </button>
                </div>
              </article>
            </div>
          </section>
        </div>
      </section>

      <!-- 账本流水 -->
      <section class="list-panel journal">
        <div class="toolbar">
          <h2>账本流水</h2>
          <span class="hint">只追加；差额类条目带金额，重放命中幂等键自动跳过</span>
        </div>
        <div class="journal-list">
          <div v-for="e in store.entries" :key="e.entryId" class="entry">
            <span class="entry-seq">#{{ e.seq }}</span>
            <span class="status" :class="`kind-${e.kind}`">{{ KIND_LABELS[e.kind] ?? e.kind }}</span>
            <span class="entry-memo">{{ e.memo }}</span>
            <strong v-if="showAmount(e.kind)" :class="e.amount >= 0 ? 'amt-pos' : 'amt-neg'">
              {{ e.amount >= 0 ? "+" : "" }}{{ fmtMoney(e.amount) }}
            </strong>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
