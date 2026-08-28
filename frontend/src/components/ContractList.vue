<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useStore } from '../store'
import { shorten } from '../chain/wallet'
import type { Contract, OperationKind } from '../types'

/**
 * 合约区。
 * 顶部一行放全部控制（签名方式、快捷勾选、已选数、批量操作），
 * 下面按业务线一块一块排，每块一张表。
 */
const store = useStore()

const allChecked = computed({
  get: () =>
    store.visibleContracts.length > 0 &&
    store.selectedContracts.length === store.visibleContracts.filter(store.canOperate).length,
  set: (value: boolean) => store.toggleAll(value),
})

const statusOf = (contract: Contract) => {
  const state = store.states.get(contract.id)
  if (state?.pending) return { text: pendingLabel(state.pending), type: 'warning' as const }
  if (state?.paused === true) return { text: '已暂停', type: 'danger' as const }
  if (state?.paused === false) return { text: '运行中', type: 'success' as const }
  return { text: '未知', type: 'info' as const }
}

const pendingLabel = (phase: string): string =>
  ({ simulate: '预演中', sign: '签名中', broadcast: '广播中', skip: '已跳过' })[phase] ?? '处理中'

const explorerUrl = (contract: Contract): string => {
  const state = store.states.get(contract.id)
  if (state?.explorerUrl) return state.explorerUrl
  const chain = store.chainOf(contract.chain)
  return chain ? `${chain.explorer.replace(/\/$/, '')}/address/${contract.address}` : '#'
}

const canWrite = computed(() => store.operator?.role !== 'viewer')

async function run(operation: OperationKind) {
  const targets = store.selectedContracts
  if (targets.length === 0) return ElMessage.warning('请先勾选合约')

  const label = operation === 'pause' ? '暂停' : '恢复'
  try {
    await ElMessageBox.confirm(
      `即将${label} ${targets.length} 个合约：\n${targets.map((c) => `· ${c.name}（${c.chain}）`).join('\n')}\n\n请输入 CONFIRM 确认`,
      `批量${label}`,
      {
        type: 'warning',
        showInput: true,
        inputPattern: /^CONFIRM$/,
        inputErrorMessage: '请输入 CONFIRM',
        confirmButtonText: `确认${label}`,
        cancelButtonText: '取消',
      },
    )
  } catch {
    return // 用户取消
  }

  try {
    // GPG 模式不需要输任何密钥 —— 后端本地解密，需要时用户去按插在服务器上的 YubiKey
    const { ok, failed } = await (store.mode === 'wallet'
      ? store.runWalletBatch(operation)
      : store.runGpgBatch(operation))

    /**
     * 按真实结果给提示。
     * 两个 batch 函数都把错误吞进事件流里正常返回，所以下面的 catch 基本不会触发 ——
     * 无条件报"已完成"的话，10 个合约全失败用户也只看到一条绿色成功提示。
     * 紧急暂停时这个代价太高。
     */
    if (failed === 0) ElMessage.success(`批量${label}完成：${ok} 个成功`)
    else if (ok === 0) ElMessage.error(`批量${label}失败：${failed} 个都没成功，详见执行进度`)
    else ElMessage.warning(`批量${label}：成功 ${ok} 个，失败 ${failed} 个，详见执行进度`)
  } catch (error) {
    ElMessage.error((error as Error).message ?? '执行失败')
  }
}
</script>

<template>
  <div class="list">
    <!-- 顶部一行：签名方式 + 快捷勾选 + 已选 + 批量操作 -->
    <div class="list__bar">
      <el-radio-group v-model="store.mode" :disabled="store.running">
        <el-radio-button value="gpg">GPG 批量</el-radio-button>
        <el-radio-button value="wallet">钱包签名</el-radio-button>
      </el-radio-group>

      <el-divider direction="vertical" />

      <el-checkbox v-model="allChecked" :disabled="store.running">全选</el-checkbox>

      <el-button-group>
        <el-button
          :disabled="store.running || store.countByState(false) === 0"
          @click="store.selectByState('needPause')"
        >
          需暂停（{{ store.countByState(false) }}）
        </el-button>
        <el-button
          :disabled="store.running || store.countByState(true) === 0"
          @click="store.selectByState('needResume')"
        >
          需恢复（{{ store.countByState(true) }}）
        </el-button>
      </el-button-group>

      <span class="list__selected">已选 {{ store.selectedContracts.length }}</span>

      <div class="list__spacer" />

      <el-button :loading="store.running" @click="store.refreshStates">刷新状态</el-button>
      <el-button
        type="warning"
        :loading="store.running"
        :disabled="!canWrite"
        @click="run('unpause')"
      >
        批量恢复
      </el-button>
      <el-button type="danger" :loading="store.running" :disabled="!canWrite" @click="run('pause')">
        批量暂停
      </el-button>
    </div>

    <el-alert v-if="!canWrite" type="info" :closable="false" show-icon title="只读账号，不能执行操作" />

    <!-- 一个业务线一块 -->
    <div class="list__groups">
      <div v-for="group in store.groups" :key="group.line.id" class="list__group">
        <div class="list__groupHead">
          <span class="list__groupName">{{ group.line.name }}</span>
          <el-tag size="small" type="info" effect="plain">{{ group.contracts.length }}</el-tag>
        </div>

        <el-table :data="group.contracts" size="small">
          <el-table-column width="46">
            <template #default="{ row }: { row: Contract }">
              <el-checkbox
                :model-value="store.selected.has(row.id)"
                :disabled="store.running || !store.canOperate(row)"
                @change="store.toggle(row.id)"
              />
            </template>
          </el-table-column>

          <el-table-column label="合约" min-width="180">
            <template #default="{ row }: { row: Contract }">
              <div class="list__name">{{ row.name }}</div>
              <a class="list__addr" :href="explorerUrl(row)" target="_blank" rel="noreferrer">
                {{ shorten(row.address, 8, 6) }}
              </a>
            </template>
          </el-table-column>

          <el-table-column label="链" width="150">
            <template #default="{ row }: { row: Contract }">
              <el-tag size="small" effect="plain">
                {{ row.chain }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="状态" width="100">
            <template #default="{ row }: { row: Contract }">
              <el-tag :type="statusOf(row).type" size="small">{{ statusOf(row).text }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="交易" width="120">
            <template #default="{ row }: { row: Contract }">
              <a
                v-if="store.states.get(row.id)?.hash"
                :href="store.states.get(row.id)!.explorerUrl"
                target="_blank"
                rel="noreferrer"
              >
                {{ shorten(store.states.get(row.id)!.hash!, 6, 4) }}
              </a>
              <span v-else class="list__dim">—</span>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <el-empty
        v-if="store.groups.length === 0"
        description="在左侧勾选业务线"
        :image-size="70"
      />
    </div>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  min-height: 0;
  height: 100%;
}
.list__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.list__selected {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.list__spacer {
  flex: 1;
}
.list__groups {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.list__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.list__groupHead {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}
.list__groupName {
  color: var(--el-text-color-primary);
}
.list__name {
  font-weight: 500;
}
.list__addr,
a {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: var(--el-color-primary);
  text-decoration: none;
}
.list__dim {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
