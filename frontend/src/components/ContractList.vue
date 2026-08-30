<script setup lang="ts">
import { computed } from 'vue'
import { ElMessage, ElMessageBox, type CheckboxValueType } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { useStore } from '../store'
import { shorten, explorerAddressUrl } from '../chain'
import { pendingLabel } from '../labels'
import type { Contract, Operation } from '../types'

/**
 * 合约区。
 * 顶部一行放全部控制（签名方式、快捷勾选、已选数、批量操作），
 * 下面按业务线一块一块排，每块一张表。
 */
const store = useStore()

/** 判定逻辑在 store 里，和分组表头共用一份 */
const allChecked = computed({
  get: () => store.visibleSelection.allSelected,
  set: (value: boolean) => store.toggleAll(value),
})

/**
 * operator 余额显示。
 *
 * 三种情况要分清：没配 operator（—）、读不到（?）、真实数值。
 * 读不到显示成 0 的话，运维会跑去给一个其实好好的地址充值；
 * 而真的没气时又和读不到长得一样，反倒没人当回事。
 */
const balanceText = (contract: Contract): string => {
  const balance = store.states.get(contract.id)?.operatorBalance
  if (balance === undefined) return '读取中…'
  const symbol = store.chainOf(contract.chain)?.symbol ?? ''
  // 小额要看清几个零，大额不用；6 位有效数字够运维判断"够不够发几笔"
  const num = Number(balance)
  const shown = num === 0 ? '0' : num < 1 ? num.toPrecision(3) : num.toFixed(4)
  return `${shown} ${symbol}`.trim()
}

/** 余额为 0 标红 —— 那是"按下去一定失败"，比状态未知更该被看见 */
const balanceClass = (contract: Contract): string => {
  const balance = store.states.get(contract.id)?.operatorBalance
  if (balance === undefined) return 'list__muted'
  return Number(balance) === 0 ? 'list__danger' : ''
}

const statusOf = (contract: Contract) => {
  const state = store.states.get(contract.id)
  if (state?.pending) return { text: pendingLabel(state.pending), type: 'warning' as const }
  if (state?.paused === true) return { text: '已暂停', type: 'danger' as const }
  if (state?.paused === false) return { text: '运行中', type: 'success' as const }
  return { text: '未知', type: 'info' as const }
}

const explorerUrl = (contract: Contract): string => {
  const state = store.states.get(contract.id)
  // 执行过就用后端给的交易链接，否则指向合约地址
  return state?.explorerUrl ?? explorerAddressUrl(store.chainOf(contract.chain), contract.address)
}

/**
 * 未登录时必须是 false。
 * 原来写的是 `store.operator?.role !== 'viewer'` —— operator 为 null 时
 * `undefined !== 'viewer'` 成立，反而算成「有写权限」。
 * 目前被 App.vue 的 v-if 挡着看不出来，但权限判断不该依赖调用点。
 */
const canWrite = computed(() => {
  const operator = store.operator
  return operator !== null && operator.role !== 'viewer'
})

/** 确认框里最多列几个合约，其余折成一句 —— 批量几十个时弹窗会撑出屏幕 */
const CONFIRM_PREVIEW = 8

/**
 * 按钮配色。颜色是**风险提示**，后端下发不了，所以留在前端。
 *
 * 认不出的新操作按普通按钮渲染：宁可不显眼，也不能给一个不知道会做什么的操作
 * 套上红色，那等于替它背书说"这是紧急暂停"。
 */
const BUTTON_TYPE: Readonly<Record<string, 'danger' | 'warning'>> = {
  pause: 'danger',
  unpause: 'warning',
}
const buttonTypeOf = (kind: string) => BUTTON_TYPE[kind] ?? 'primary'


/** 操作与中文名都来自 store 的清单，这里不再认识具体是哪一种操作 */
async function run(operation: Operation) {
  const targets = store.selectedContracts
  if (targets.length === 0) return ElMessage.warning('请先勾选合约')

  const label = operation.label
  try {
    const preview = targets
      .slice(0, CONFIRM_PREVIEW)
      .map((c) => `· ${c.name}（${c.chain}）`)
      .join('\n')
    const rest =
      targets.length > CONFIRM_PREVIEW ? `\n· …另外 ${targets.length - CONFIRM_PREVIEW} 个` : ''

    await ElMessageBox.confirm(
      `即将${label} ${targets.length} 个合约：\n${preview}${rest}\n\n请输入 CONFIRM 确认`,
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
      ? store.runWalletBatch(operation.kind)
      : store.runGpgBatch(operation.kind))

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
        <el-radio-button value="wallet">钱包签名</el-radio-button>
        <el-radio-button value="gpg">GPG 批量</el-radio-button>
      </el-radio-group>

      <el-divider direction="vertical" />

      <el-checkbox
        v-model="allChecked"
        :indeterminate="store.visibleSelection.someSelected"
        :disabled="store.running || store.visibleSelection.selectable === 0"
      >
        全选
      </el-checkbox>

      <span class="list__selected">已选 {{ store.selectedContracts.length }}</span>

      <div class="list__spacer" />

      <el-button
        v-if="store.groups.length > 1"
        text
        @click="store.setAllCollapsed(!store.allCollapsed)"
      >
        {{ store.allCollapsed ? '全部展开' : '全部收起' }}
      </el-button>

      <el-button :loading="store.running" @click="store.refreshStates">刷新状态</el-button>
      <!-- 操作按钮由后端下发的清单生成：后端加一种操作，这里自动多一个按钮 -->
      <el-button
        v-for="operation in store.operations"
        :key="operation.kind"
        :type="buttonTypeOf(operation.kind)"
        :loading="store.running"
        :disabled="!canWrite"
        @click="run(operation)"
      >
        批量{{ operation.label }}
      </el-button>
    </div>

    <el-alert v-if="!canWrite" type="info" :closable="false" show-icon title="只读账号，不能执行操作" />

    <!-- 一个业务线一块 -->
    <div class="list__groups">
      <div v-for="group in store.groups" :key="group.line.id" class="list__group">
        <div class="list__groupHead">
          <!-- 只全选这条业务线，其余业务线已勾的保持不变 -->
          <el-checkbox
            :model-value="group.allSelected"
            :indeterminate="group.someSelected"
            :disabled="store.running || group.selectable === 0"
            @change="(v: CheckboxValueType) => store.toggleLineSelection(group.line.id, v === true)"
          />

          <button
            type="button"
            class="list__groupToggle"
            :aria-expanded="!group.collapsed"
            @click="store.toggleCollapse(group.line.id)"
          >
            <el-icon class="list__caret" :class="{ 'list__caret--off': group.collapsed }">
              <ArrowDown />
            </el-icon>
            <span class="list__groupName">{{ group.line.name }}</span>
          </button>

          <el-tag size="small" type="info" effect="plain">{{ group.contracts.length }}</el-tag>

          <!-- 折叠起来也看得到里面选了几个，避免误操作看不见的合约 -->
          <el-tag v-if="group.selectedCount > 0" size="small" effect="plain">
            已选 {{ group.selectedCount }}
          </el-tag>

          <div class="list__spacer" />

          <!--
            这条业务线自己的快捷勾选。只动本业务线，其余已勾的保持不变 ——
            运维经常只想对某一条业务线下手，不该冲掉别处选好的。
          -->
          <el-button-group>
            <el-button
              size="small"
              :disabled="store.running || group.needPause === 0"
              @click.stop="store.selectByState('needPause', group.line.id)"
            >
              需暂停 {{ group.needPause }}
            </el-button>
            <el-button
              size="small"
              :disabled="store.running || group.needResume === 0"
              @click.stop="store.selectByState('needResume', group.line.id)"
            >
              需恢复 {{ group.needResume }}
            </el-button>
          </el-button-group>
        </div>

        <el-table v-show="!group.collapsed" :data="group.contracts" size="small">
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

          <!--
            operator 余额：紧急暂停时最怕的是按下去才发现那个地址没气了。
            读不到显示 —— 而不是 0，两者含义完全不同。
          -->
          <el-table-column label="operator 余额" width="150">
            <template #default="{ row }: { row: Contract }">
              <span v-if="!row.operator" class="list__muted">—</span>
              <a
                v-else
                class="list__addr"
                :href="explorerAddressUrl(store.chainOf(row.chain), row.operator)"
                target="_blank"
                rel="noreferrer"
                :title="row.operator"
              >
                <span :class="balanceClass(row)">{{ balanceText(row) }}</span>
              </a>
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
.list__groupToggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.list__caret {
  color: var(--el-text-color-secondary);
  transition: transform 0.2s ease;
}
.list__caret--off {
  transform: rotate(-90deg);
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
