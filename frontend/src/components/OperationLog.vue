<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useStore } from '../store'
import { shorten, explorerTxUrl } from '../chain'
import type { OperationLog, TxLogStatus } from '../types'
import { isFuture, monthOf, shiftDay, toDay, today } from '../day'

/**
 * 交易日志：一笔交易一行，显示它**当前的**状态。
 *
 * 之前这里只显示终态（confirmed / failed），有个后果：
 * **钱包模式发出去的交易永远不出现在日志里**。钱包模式下前端只在广播成功后
 * 上报一条 broadcast，此后没有任何东西会把它更新成 confirmed，
 * 于是运维刚点完暂停，日志区却一直是「暂无交易记录」。
 *
 * 现在改成按交易哈希去重、保留最新的那条状态：
 *   GPG 模式   后端会为同一笔写两条（广播时、确认后），去重后只留确认后的
 *   钱包模式   只有 broadcast 一条，照常显示，标成「已广播」
 */
const store = useStore()
const autoScroll = ref(true)
const body = ref<HTMLElement | null>(null)

/**
 * 日志按天看。
 *
 * 换天会**重新去后端拉那一天** —— 本地筛的话，选到没拉下来的日子就是一片空白，
 * 而运维会以为那天什么都没发生。
 */
const switching = ref(false)

async function go(day: string): Promise<void> {
  if (switching.value || isFuture(day)) return
  switching.value = true
  try {
    await store.setLogDay(day)
  } finally {
    switching.value = false
  }
}

const isToday = computed(() => store.logDay === today())
const dayLabel = computed(() => (isToday.value ? '今天' : store.logDay))

/** 日历格子上的笔数。0 不显示 —— 满屏的 0 比没有还吵 */
const countOn = (date: Date): number => store.dailyCounts[toDay(date)] ?? 0

/** 翻月时把那个月的计数补上 */
function onPanelChange(date: Date): void {
  void store.loadDailyCounts(monthOf(toDay(date)))
}

const STATUS: Readonly<
  Record<TxLogStatus, { label: string; type: 'success' | 'danger' | 'warning' | 'info' }>
> = {
  confirmed: { label: '已确认', type: 'success' },
  failed: { label: '失败', type: 'danger' },
  broadcast: { label: '已广播', type: 'warning' },
  cancelled: { label: '已取消', type: 'info' },
}

/** 同一笔交易可能有多条记录，哈希是它的身份；缺哈希的退回时间+合约 */
const keyOf = (entry: OperationLog): string => entry.hash || `${entry.ts}-${entry.contract}`

const finalized = computed<OperationLog[]>(() => {
  // store.logs 由后端按时间倒序给出，所以每个哈希**第一次**出现的就是最新那条
  const latest = new Map<string, OperationLog>()
  for (const entry of store.logs) {
    const key = keyOf(entry)
    if (!latest.has(key)) latest.set(key, entry)
  }
  return [...latest.values()]
})


watch(
  () => finalized.value.length,
  async () => {
    if (!autoScroll.value) return
    await nextTick()
    body.value?.scrollTo({ top: 0 })
  },
)

const time = (ts: string): string =>
  new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** 浏览器链接由链族自己拼 —— 各链路径不一样，组件不该知道这件事 */
const explorerUrl = (chain: string, hash: string): string =>
  explorerTxUrl(store.chainOf(chain), hash)
</script>

<template>
  <div class="log">
    <div class="log__head">
      <span class="log__title">交易日志</span>
      <el-tag size="small" type="info" effect="plain">{{ finalized.length }}</el-tag>

      <div class="log__day">
        <el-button size="small" text :disabled="switching" @click="go(shiftDay(store.logDay, -1))">
          ‹
        </el-button>

        <el-date-picker
          :model-value="store.logDay"
          type="date"
          size="small"
          value-format="YYYY-MM-DD"
          format="MM月DD日"
          :clearable="false"
          :disabled-date="(d: Date) => d.getTime() > Date.now()"
          class="log__picker"
          @update:model-value="(d: string) => d && go(d)"
          @panel-change="onPanelChange"
        >
          <!-- 格子上标出那天有几笔，一眼看出哪天动过 -->
          <template #default="cell">
            <div class="logcell" :class="{ 'logcell--has': countOn(cell.date) > 0 }">
              <span>{{ cell.text }}</span>
              <span v-if="countOn(cell.date) > 0" class="logcell__count">
                {{ countOn(cell.date) }}
              </span>
            </div>
          </template>
        </el-date-picker>

        <el-button
          size="small"
          text
          :disabled="switching || isToday"
          @click="go(shiftDay(store.logDay, 1))"
        >
          ›
        </el-button>

        <el-button v-if="!isToday" size="small" text @click="go(today())">回到今天</el-button>
      </div>

      <div class="log__spacer" />
      <el-checkbox v-model="autoScroll" size="small">自动滚动</el-checkbox>
    </div>

    <div ref="body" class="log__body">
      <div v-for="entry in finalized" :key="keyOf(entry)" class="log__row">
        <span class="log__time">{{ time(entry.ts) }}</span>
        <el-tag size="small" :type="STATUS[entry.status].type" effect="plain">
          {{ STATUS[entry.status].label }}
        </el-tag>
        <!-- 中文名从后端下发的操作清单取；二选一的老写法会把别的操作也显示成"恢复" -->
        <span class="log__op">{{ store.operationLabel(entry.operation) }}</span>
        <span class="log__contract">{{ entry.contract }}</span>
        <span class="log__chain">@{{ entry.chain }}</span>
        <a
          v-if="entry.hash"
          class="log__hash"
          :href="explorerUrl(entry.chain, entry.hash)"
          target="_blank"
          rel="noreferrer"
        >
          {{ shorten(entry.hash, 8, 6) }}
        </a>
        <span class="log__addr">{{ shorten(entry.address) }}</span>
      </div>

      <div v-if="finalized.length === 0" class="log__empty">
        {{ dayLabel }}没有交易记录
      </div>
    </div>
  </div>
</template>

<style scoped>
.log {
  display: flex;
  flex-direction: column;
  height: 200px;
  border-top: 1px solid var(--el-border-color-light);
  background: var(--el-fill-color-lighter);
}
.log__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.log__title {
  font-size: 13px;
  font-weight: 600;
}
.log__day {
  display: flex;
  align-items: center;
  gap: 2px;
}
.log__picker {
  width: 128px;
}
.log__spacer {
  flex: 1;
}
.log__body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 20px;
  font-size: 12px;
}
.log__row {
  display: flex;
  align-items: center;
  gap: 10px;
  line-height: 2.2;
}
.log__time {
  color: var(--el-text-color-secondary);
  font-family: ui-monospace, monospace;
  flex: none;
}
.log__op {
  font-weight: 500;
}
.log__contract {
  color: var(--el-text-color-regular);
}
.log__chain,
.log__addr {
  color: var(--el-text-color-secondary);
}
.log__hash {
  font-family: ui-monospace, monospace;
  color: var(--el-color-primary);
  text-decoration: none;
}
.log__empty {
  color: var(--el-text-color-placeholder);
  text-align: center;
  padding: 40px 0;
}
</style>

<!--
  日历格子的样式不能 scoped —— el-date-picker 的浮层挂在 body 上，
  scoped 生成的属性选择器够不着它。类名带 logcell 前缀避免撞车。
-->
<style>
.logcell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  line-height: 1.1;
  height: 100%;
}
.logcell__count {
  font-size: 10px;
  color: var(--el-color-primary);
  font-weight: 600;
}
/* 有操作的那天加个底色，扫一眼就知道哪几天动过 */
.logcell--has {
  background: var(--el-color-primary-light-9);
  border-radius: 4px;
}
.el-date-table td.current .logcell--has,
.el-date-table td.today .logcell--has {
  background: transparent;
}
.el-date-table td.current .logcell__count {
  color: #fff;
}
</style>
