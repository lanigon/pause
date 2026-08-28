<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useStore } from '../store'
import { shorten } from '../chain/wallet'

/**
 * 操作日志。
 * **只显示交易的终态**（已确认 / 失败）—— 广播中这种中间态在上面的实时进度里看，
 * 日志要回答的是"最后到底成了没有"。
 */
const store = useStore()
const autoScroll = ref(true)
const body = ref<HTMLElement | null>(null)

const finalized = computed(() =>
  store.logs.filter((entry) => entry.status === 'confirmed' || entry.status === 'failed'),
)

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

const explorerUrl = (chain: string, hash: string): string => {
  const c = store.chainOf(chain)
  return c ? `${c.explorer.replace(/\/$/, '')}/tx/${hash}` : '#'
}
</script>

<template>
  <div class="log">
    <div class="log__head">
      <span class="log__title">交易日志</span>
      <el-tag size="small" type="info" effect="plain">{{ finalized.length }}</el-tag>
      <div class="log__spacer" />
      <el-checkbox v-model="autoScroll" size="small">自动滚动</el-checkbox>
    </div>

    <div ref="body" class="log__body">
      <div v-for="(entry, index) in finalized" :key="`${entry.ts}-${index}`" class="log__row">
        <span class="log__time">{{ time(entry.ts) }}</span>
        <el-tag
          size="small"
          :type="entry.status === 'confirmed' ? 'success' : 'danger'"
          effect="plain"
        >
          {{ entry.status === 'confirmed' ? '已确认' : '失败' }}
        </el-tag>
        <span class="log__op">{{ entry.operation === 'pause' ? '暂停' : '恢复' }}</span>
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

      <div v-if="finalized.length === 0" class="log__empty">暂无交易记录</div>
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
