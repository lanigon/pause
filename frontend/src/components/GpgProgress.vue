<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useStore } from '../store'
import { phaseLabel } from '../labels'
import type { ExecutionEvent } from '../types'

/**
 * GPG 批量执行的进度弹窗，两个 tab：
 *
 *   执行过程 —— SSE 推来的每一步，尤其是"请触摸 YubiKey"这种必须立刻看到的提示
 *   交易结果 —— 一个合约一行的最终结果，带哈希和浏览器链接
 *
 * 分开是因为两者的读法不同：过程要按时间倒序扫，结果要按合约查。
 */
/** 结果表的一行：一个合约一行 */
interface Row {
  contractId: string
  name: string
  chain: string
  phase: string
  message: string
  hash?: string
  explorerUrl?: string
}

const store = useStore()

const visible = computed(() => store.mode === 'gpg' && (store.running || store.events.length > 0))
const finished = computed(() => !store.running && store.events.length > 0)

const tab = ref<'timeline' | 'results'>('timeline')

const typeOf = (phase: string): 'primary' | 'success' | 'warning' | 'danger' | 'info' =>
  (({
    decrypt: 'warning',
    simulate: 'primary',
    balance: 'warning',
    sign: 'primary',
    broadcast: 'primary',
    confirmed: 'success',
    failed: 'danger',
    error: 'danger',
    done: 'success',
    skip: 'info',
  }) as Record<string, 'primary' | 'success' | 'warning' | 'danger' | 'info'>)[phase] ?? 'primary'

/* ── tab 1：执行过程 ── */

const steps = computed(() => store.events.slice().reverse())

/** 需要用户去按 YubiKey 的时候，把提示顶到最上面 */
const touchPrompt = computed(() =>
  store.running ? steps.value.find((s) => s.message.includes('请触摸')) : undefined,
)

/* ── tab 2：交易结果 ── */

/** 终态优先级：已确认/失败/跳过 是结论，其余只是过程 */
const TERMINAL = new Set(['confirmed', 'failed', 'skip'])

/**
 * 一个合约一行。
 * 取该合约最后一个终态事件；还没有终态就显示当前进行到哪一步。
 */
const rows = computed<Row[]>(() => {
  const latest = new Map<string, ExecutionEvent>()
  for (const event of store.events) {
    if (!event.contractId) continue
    const prev = latest.get(event.contractId)
    // events 是倒序 unshift 进来的，越靠前越新；终态一旦记下就不再被过程事件覆盖
    if (prev && (TERMINAL.has(prev.phase) || !TERMINAL.has(event.phase))) continue
    latest.set(event.contractId, event)
  }

  return [...latest.entries()].map(([contractId, event]) => {
    const contract = store.registry?.contracts.find((c) => c.id === contractId)
    const name = contract?.name ?? contractId
    return {
      contractId,
      name,
      chain: contract?.chain ?? event.chainKey ?? '-',
      phase: event.phase,
      // 合约名已经单独一列了，消息里重复的前缀去掉
      message: event.message.startsWith(`${name}：`)
        ? event.message.slice(name.length + 1)
        : event.message,
      hash: event.hash,
      explorerUrl: event.explorerUrl,
    }
  })
})

const confirmedCount = computed(() => rows.value.filter((r) => r.phase === 'confirmed').length)
const failedCount = computed(() => rows.value.filter((r) => r.phase === 'failed').length)

/** 跑完自动切到结果页 —— 这时候用户想看的是"成了几笔" */
watch(finished, (done) => {
  if (done && rows.value.length > 0) tab.value = 'results'
})

function close(): void {
  // 事件和失败原因一起清 —— 清理规则在 store 里，组件不直接写它的状态，
  // 不然这里少清一个 failure，下次打开就顶着上一轮的错误横幅
  store.clearEvents()
  tab.value = 'timeline'
}

async function cancel(): Promise<void> {
  await store.cancelBatch()
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    title="GPG 批量执行"
    width="720px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="finished"
    @close="close"
  >
    <el-alert
      v-if="touchPrompt"
      type="warning"
      :closable="false"
      show-icon
      class="gpg__banner"
      :title="touchPrompt.message"
      description="密钥在服务器上的 YubiKey 里，需要有人去按一下那台机器上插着的设备"
    />

    <!-- 失败原因：不只说"失败了"，还要说清是什么问题、下一步做什么 -->
    <el-alert
      v-if="store.failure"
      type="error"
      :closable="false"
      show-icon
      class="gpg__banner"
      :title="store.failure.message"
    >
      <template #default>
        <div v-if="store.failure.hint" class="gpg__hint">{{ store.failure.hint }}</div>
        <div v-if="store.failure.code" class="gpg__code">{{ store.failure.code }}</div>
      </template>
    </el-alert>

    <el-tabs v-model="tab" class="gpg__tabs">
      <el-tab-pane name="timeline">
        <template #label>
          <span>执行过程</span>
          <el-tag v-if="store.running" size="small" type="primary" effect="plain" class="gpg__badge">
            进行中
          </el-tag>
        </template>

        <el-timeline class="gpg__pane">
          <el-timeline-item
            v-for="(step, index) in steps"
            :key="index"
            :type="typeOf(step.phase)"
            :hollow="step.phase !== 'confirmed' && step.phase !== 'failed'"
            size="normal"
          >
            <div class="gpg__step">
              <el-tag size="small" :type="typeOf(step.phase)" effect="plain">
                {{ phaseLabel(step.phase) }}
              </el-tag>
              <span class="gpg__msg">{{ step.message }}</span>
            </div>
          </el-timeline-item>
        </el-timeline>
      </el-tab-pane>

      <el-tab-pane name="results">
        <template #label>
          <span>交易结果</span>
          <el-tag v-if="rows.length" size="small" effect="plain" class="gpg__badge">
            {{ confirmedCount }}/{{ rows.length }}
          </el-tag>
        </template>

        <div class="gpg__pane">
          <el-empty v-if="rows.length === 0" description="还没有交易" :image-size="72" />
          <template v-else>
            <div class="gpg__summary">
              <el-tag type="success" effect="plain">已确认 {{ confirmedCount }}</el-tag>
              <el-tag v-if="failedCount" type="danger" effect="plain">失败 {{ failedCount }}</el-tag>
              <el-tag v-if="rows.length - confirmedCount - failedCount" type="info" effect="plain">
                其他 {{ rows.length - confirmedCount - failedCount }}
              </el-tag>
            </div>

            <el-table :data="rows" size="small" class="gpg__table">
              <el-table-column prop="name" label="合约" min-width="150" show-overflow-tooltip />
              <el-table-column prop="chain" label="链" width="90" />
              <el-table-column label="状态" width="92">
                <template #default="{ row }">
                  <el-tag size="small" :type="typeOf(row.phase)" effect="plain">
                    {{ phaseLabel(row.phase) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="交易哈希" min-width="200">
                <template #default="{ row }">
                  <el-link
                    v-if="row.hash && row.explorerUrl"
                    type="primary"
                    :href="row.explorerUrl"
                    target="_blank"
                    class="gpg__hash"
                  >
                    {{ row.hash.slice(0, 12) }}…{{ row.hash.slice(-8) }}
                  </el-link>
                  <span v-else-if="row.hash" class="gpg__hash">{{ row.hash.slice(0, 18) }}…</span>
                  <span v-else class="gpg__muted">{{ row.message }}</span>
                </template>
              </el-table-column>
            </el-table>
          </template>
        </div>
      </el-tab-pane>
    </el-tabs>

    <template #footer>
      <template v-if="store.running">
        <span class="gpg__running">执行中，请勿关闭页面…</span>
        <!-- 已广播的拦不住，只能保证还没签的不签、没发的不发 -->
        <el-button type="danger" plain @click="cancel">取消执行</el-button>
      </template>
      <el-button v-else type="primary" @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.gpg__banner {
  margin-bottom: 12px;
}
.gpg__hint {
  font-size: 13px;
  line-height: 1.7;
}
.gpg__code {
  margin-top: 4px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.gpg__badge {
  margin-left: 6px;
}
.gpg__pane {
  min-height: 240px;
  max-height: 380px;
  overflow-y: auto;
  padding-top: 4px;
}
.gpg__summary {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.gpg__step {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.gpg__msg {
  font-size: 13px;
  color: var(--el-text-color-regular);
}
.gpg__hash {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
.gpg__muted {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.gpg__running {
  margin-right: 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
