<script setup lang="ts">
import { computed } from 'vue'
import { useStore } from '../store'

/**
 * 侧边栏：勾选业务线，可多选。
 * 勾中的业务线会在右侧一块一块展开。
 *
 * 顶部一条数据来源状态：每次加载后端都会先跟 Lark 对一遍，
 * 结果（用的 Lark 数据还是本地数据、有没有变更）必须让运维一眼看到 ——
 * 拿着过期的合约清单做紧急暂停是很危险的。
 */
type SourceState = { type: 'success' | 'warning' | 'info'; label: string }

const store = useStore()

const pausedOf = (lineId: string): number => store.pausedCountOf(lineId)

const source = computed<SourceState>(() => {
  if (store.loading) return { type: 'info', label: '正在同步…' }
  const result = store.syncResult
  if (!result) return { type: 'info', label: '未同步' }
  if (!result.fromLark) return { type: 'warning', label: '本地数据' }
  return result.changed
    ? { type: 'success', label: '已更新' }
    : { type: 'success', label: '与 Lark 一致' }
})

/** 有失败或有变更时值得展开看，其余折叠着不占地方 */
const worthReading = computed(() =>
  store.syncEvents.some((event) => !event.ok || (event.changes?.length ?? 0) > 0),
)

const refresh = () => store.bootstrap(true)
</script>

<template>
  <div class="sidebar">
    <div v-if="store.registry || store.loading" class="sidebar__sync">
      <el-popover placement="right-start" width="360" trigger="click" :disabled="store.syncEvents.length === 0">
        <template #reference>
          <el-tag :type="source.type" size="small" effect="plain" class="sidebar__tag">
            {{ source.label }}
            <span v-if="worthReading" class="sidebar__dot">•</span>
          </el-tag>
        </template>

        <div class="sync">
          <div v-for="(event, index) in store.syncEvents" :key="index" class="sync__row">
            <el-tag :type="event.ok ? 'info' : 'warning'" size="small" effect="plain">
              {{ { source: '拉取', diff: '比对', apply: '应用' }[event.phase] ?? event.phase }}
            </el-tag>
            <div class="sync__body">
              <div class="sync__msg">{{ event.message }}</div>
              <ul v-if="event.changes?.length" class="sync__changes">
                <li v-for="(change, i) in event.changes" :key="i">{{ change }}</li>
              </ul>
            </div>
          </div>
        </div>
      </el-popover>

      <el-button link size="small" :loading="store.loading" @click="refresh">重新同步</el-button>
    </div>

    <div class="sidebar__title">业务线</div>

    <div
      v-for="line in store.businessLines"
      :key="line.id"
      class="sidebar__item"
      :class="{ 'sidebar__item--on': store.selectedLines.has(line.id) }"
      @click="store.toggleLine(line.id)"
    >
      <el-checkbox
        :model-value="store.selectedLines.has(line.id)"
        @click.stop
        @change="store.toggleLine(line.id)"
      />
      <span class="sidebar__name">{{ line.name }}</span>
      <el-badge v-if="pausedOf(line.id) > 0" :value="pausedOf(line.id)" type="danger" />
      <span class="sidebar__count">{{ store.contractCountOf(line.id) }}</span>
    </div>

    <el-empty
      v-if="store.businessLines.length === 0"
      description="连接钱包后加载"
      :image-size="60"
    />
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  border-right: 1px solid var(--el-border-color-light);
  padding: 8px 0;
}
.sidebar__sync {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 16px 8px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.sidebar__tag {
  cursor: pointer;
}
.sidebar__dot {
  margin-left: 2px;
  color: var(--el-color-warning);
  font-weight: 700;
}
.sync {
  max-height: 320px;
  overflow-y: auto;
}
.sync__row {
  display: flex;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.sync__row:last-child {
  border-bottom: none;
}
.sync__body {
  flex: 1;
  min-width: 0;
}
.sync__msg {
  font-size: 13px;
  line-height: 1.6;
  word-break: break-word;
}
.sync__changes {
  margin: 4px 0 0;
  padding-left: 16px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.sidebar__title {
  padding: 8px 20px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  letter-spacing: 1px;
}
.sidebar__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 20px;
  height: 42px;
  cursor: pointer;
  user-select: none;
}
.sidebar__item:hover {
  background: var(--el-fill-color-light);
}
.sidebar__item--on {
  background: var(--el-color-primary-light-9);
}
.sidebar__name {
  flex: 1;
  font-size: 14px;
}
.sidebar__count {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
