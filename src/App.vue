<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import {
  CONFLICT_FIELD_LABELS,
  useLedger,
  type Batch,
  type BatchInput,
  type ConflictField
} from "./stores/ledger";

const ledger = useLedger();

const notice = ref("");

// ---------- 调价批次表单 ----------

const batchForm = reactive<BatchInput>({
  id: "",
  planNo: "",
  fuelId: "f-92",
  price: 0,
  effectiveAt: new Date().toISOString().slice(0, 16),
  operator: "",
  source: "窗口"
});

const lastOfflinePackage = ref<BatchInput | null>(null);

function submitBatch() {
  const input: BatchInput = { ...batchForm, id: batchForm.id || undefined };
  notice.value = ledger.submitBatch(input);
  if (input.source === "断网补送") {
    lastOfflinePackage.value = { ...input, id: input.id ?? "" };
  }
  batchForm.id = "";
  batchForm.planNo = "";
  batchForm.price = 0;
  batchForm.operator = "";
}

/** 断网恢复后重放上一包：批次ID相同，应被忽略且不重复记差额 */
function replayOfflinePackage() {
  if (!lastOfflinePackage.value) {
    notice.value = "暂无可重放的断网包，请先用“断网补送”来源提交一笔";
    return;
  }
  notice.value = ledger.submitBatch({ ...lastOfflinePackage.value });
}

// ---------- 经理冲突裁定 ----------

const resolutions = reactive<Record<string, Record<ConflictField, "local" | "incoming">>>({});

function resolutionFor(batch: Batch) {
  if (!resolutions[batch.id]) {
    resolutions[batch.id] = { price: "local", effectiveAt: "local", operator: "local" };
  }
  return resolutions[batch.id];
}

function confirmConflicts(batch: Batch) {
  ledger.resolveConflicts(batch.id, resolutionFor(batch));
  notice.value = `批次 ${batch.planNo} 冲突已确认，转待裁草稿`;
}

// ---------- 换班结账 ----------

const shiftForm = reactive({ shiftNo: "", fuelId: "f-92", volume: 1000 });

function closeShift() {
  notice.value = ledger.closeShift(shiftForm.shiftNo, shiftForm.fuelId, Number(shiftForm.volume));
  shiftForm.shiftNo = "";
}

// ---------- 展示 ----------

const sortedVersions = computed(() =>
  [...ledger.versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12)
);

const statusClass = (status: string) =>
  ({
    生效: "ok",
    待裁草稿: "warn",
    待确认: "warn",
    已驳回: "muted",
    已替换: "muted",
    未确认: "warn",
    已确认: "ok",
    已失效: "muted"
  })[status] ?? "muted";

const metrics = computed(() => [
  { label: "生效批次", value: ledger.batches.filter((b) => b.status === "生效").length },
  { label: "待裁定/待确认", value: ledger.awaitingCount },
  { label: "未确认差额(¥)", value: ledger.pendingDiffTotal },
  { label: "已确认差额(¥)", value: ledger.confirmedDiffTotal }
]);

function simulateFailure() {
  ledger.simulateSaveFailureAndRecover();
  notice.value = "已模拟保存失败并从上一个完整批次恢复";
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 站控价格账本</p>
          <h1>油品价格维护</h1>
          <p class="subtitle">
            油品、调价批次、生效版本与换班小票一本账：同计划编号先到者占生效位，后到内容转待裁草稿；
            断网包按字段合并、冲突两值保留，经理确认前不计售价和差额；保存失败从完整批次恢复，重放不重复记差额。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue3</span>
          <span class="tag">Pinia</span>
          <span class="tag">TypeScript</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <p v-if="notice" class="notice">{{ notice }}</p>

      <section class="workspace">
        <div class="side">
          <form class="panel" @submit.prevent="submitBatch">
            <h2>调价批次录入</h2>
            <div class="form-grid">
              <label>
                计划编号
                <input v-model="batchForm.planNo" required placeholder="如 PLAN-2026-101" />
              </label>
              <label>
                油品
                <select v-model="batchForm.fuelId">
                  <option v-for="fuel in ledger.fuels" :key="fuel.id" :value="fuel.id">{{ fuel.name }}</option>
                </select>
              </label>
              <label>
                挂牌价
                <input v-model="batchForm.price" type="number" step="0.01" min="0" required />
              </label>
              <label>
                生效时刻
                <input v-model="batchForm.effectiveAt" type="datetime-local" required />
              </label>
              <label>
                操作员
                <input v-model="batchForm.operator" required placeholder="值班人姓名" />
              </label>
              <label>
                来源
                <select v-model="batchForm.source">
                  <option>窗口</option>
                  <option>断网补送</option>
                </select>
              </label>
              <label>
                批次ID（断网包自带，可留空）
                <input v-model="batchForm.id" placeholder="重放去重依据" />
              </label>
              <button type="submit">提交批次</button>
            </div>
          </form>

          <form class="panel" @submit.prevent="closeShift">
            <h2>换班结账</h2>
            <div class="form-grid">
              <label>
                班次号
                <input v-model="shiftForm.shiftNo" required placeholder="如 20261006-晚班" />
              </label>
              <label>
                油品
                <select v-model="shiftForm.fuelId">
                  <option v-for="fuel in ledger.fuels" :key="fuel.id" :value="fuel.id">{{ fuel.name }}</option>
                </select>
              </label>
              <label>
                班次销量（升）
                <input v-model="shiftForm.volume" type="number" min="0" step="1" required />
              </label>
              <button type="submit">开具小票</button>
            </div>
          </form>

          <section class="panel">
            <h2>容灾演练</h2>
            <div class="actions">
              <button type="button" class="secondary" @click="replayOfflinePackage">重放上一断网包</button>
              <button type="button" class="secondary" @click="simulateFailure">模拟保存失败并恢复</button>
            </div>
          </section>
        </div>

        <div class="main-col">
          <section class="list-panel">
            <div class="toolbar"><h2>油品现价板</h2></div>
            <div class="board">
              <article v-for="fuel in ledger.priceBoard" :key="fuel.id" class="board-card">
                <span>{{ fuel.name }}</span>
                <strong>¥{{ fuel.price.toFixed(2) }}</strong>
                <em>v{{ fuel.version }} · {{ fuel.effectiveAt }} 起生效</em>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar"><h2>调价批次账本</h2></div>
            <div class="record-grid">
              <div v-if="ledger.batches.length === 0" class="empty">暂无批次，请从左侧录入</div>
              <article v-for="batch in ledger.batches" :key="batch.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ batch.planNo }} / {{ ledger.fuelName(batch.fuelId) }} / ¥{{ batch.price.toFixed(2) }}</p>
                  <span class="status" :class="statusClass(batch.status)">{{ batch.status }}</span>
                </div>
                <div class="details">
                  <span>批次ID: {{ batch.id.slice(0, 8) }}</span>
                  <span>来源: {{ batch.source }}</span>
                  <span>生效时刻: {{ batch.effectiveAt }}</span>
                  <span>操作员: {{ batch.operator }}</span>
                  <span v-if="batch.version">生效版本: v{{ batch.version }}</span>
                </div>

                <div v-if="batch.conflicts.length > 0" class="conflicts">
                  <p class="conflict-title">字段冲突（两值保留，经理确认前不计售价和差额）：</p>
                  <div v-for="conflict in batch.conflicts" :key="conflict.field" class="conflict-row">
                    <span>{{ CONFLICT_FIELD_LABELS[conflict.field] }}</span>
                    <label>
                      <input v-model="resolutionFor(batch)[conflict.field]" type="radio" value="local" />
                      本地 {{ conflict.local }}
                    </label>
                    <label>
                      <input v-model="resolutionFor(batch)[conflict.field]" type="radio" value="incoming" />
                      补送 {{ conflict.incoming }}
                    </label>
                  </div>
                  <div class="actions">
                    <button type="button" @click="confirmConflicts(batch)">经理确认</button>
                    <button type="button" class="danger" @click="ledger.rejectBatch(batch.id)">驳回</button>
                  </div>
                </div>

                <div v-else-if="batch.status === '待裁草稿'" class="actions">
                  <button type="button" @click="ledger.approveDraft(batch.id)">批准生效</button>
                  <button type="button" class="danger" @click="ledger.rejectBatch(batch.id)">驳回</button>
                </div>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar"><h2>换班小票</h2></div>
            <div class="record-grid">
              <div v-if="ledger.receipts.length === 0" class="empty">暂无小票</div>
              <article v-for="receipt in ledger.receipts" :key="receipt.id" class="record">
                <div class="record-head">
                  <p class="record-title">{{ receipt.shiftNo }} / {{ ledger.fuelName(receipt.fuelId) }}</p>
                  <span class="status" :class="statusClass(receipt.status)">{{ receipt.status }}</span>
                </div>
                <div class="details">
                  <span>销量: {{ receipt.volume }}L</span>
                  <span>计价: ¥{{ receipt.price.toFixed(2) }}（v{{ receipt.version }}）</span>
                  <span>上版价: ¥{{ receipt.prevPrice.toFixed(2) }}</span>
                  <span>差额: ¥{{ receipt.diff.toFixed(2) }}</span>
                </div>
                <div v-if="receipt.status === '未确认'" class="actions">
                  <button type="button" @click="ledger.confirmReceipt(receipt.id)">确认差额</button>
                </div>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar"><h2>生效版本时间线</h2></div>
            <div class="record-grid">
              <article v-for="version in sortedVersions" :key="`${version.fuelId}-${version.version}`" class="record">
                <div class="record-head">
                  <p class="record-title">{{ ledger.fuelName(version.fuelId) }} · v{{ version.version }} · ¥{{ version.price.toFixed(2) }}</p>
                  <span class="status ok">生效</span>
                </div>
                <div class="details">
                  <span>计划编号: {{ version.planNo }}</span>
                  <span>生效时刻: {{ version.effectiveAt }}</span>
                </div>
              </article>
            </div>
          </section>

          <section class="list-panel">
            <div class="toolbar"><h2>事件日志</h2></div>
            <ul class="event-log">
              <li v-for="(event, index) in ledger.events" :key="index">{{ event }}</li>
            </ul>
          </section>
        </div>
      </section>
    </div>
  </main>
</template>
