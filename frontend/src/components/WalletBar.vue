<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowDown } from '@element-plus/icons-vue'
import { useStore } from '../store'
import { byFamily, discoverWallets, FAMILIES, shorten, type WalletAdapter } from '../chain/wallet'
import type { ChainFamily } from '../types'

/**
 * 顶栏钱包区：EVM 和 Tron 各一个按钮，点开是那个链族下装了哪些钱包，点哪个连哪个。
 *
 * 为什么要列出来而不是直接连：用户同时装 MetaMask、OKX、Rabby 是常态，
 * 它们会抢 window.ethereum，谁最后注入谁赢 —— 直接连的话用户根本不知道
 * 自己在用哪个。EIP-6963 让每个钱包各自应答，选谁就用谁的 provider。
 *
 * 只有 EVM 参与登录（身份就是一个 EVM 地址），Tron 连上只是为了在钱包模式下
 * 给 Tron 合约发交易。按钮上标出来，免得连了 Tron 却发现没登录进去。
 */
const store = useStore()

const connecting = ref<string | null>(null)
// 从 FAMILIES 生成，加一族不会漏掉这里 —— 漏了的话模板里 found[家族].some 会直接崩
const found = ref<Record<ChainFamily, readonly WalletAdapter[]>>(
  byFamily<readonly WalletAdapter[]>(() => []),
)
const scanning = ref(false)

/** 装没装插件不是响应式的：进页面扫一次，每次点开按钮再扫一次 */
async function scan(family: ChainFamily): Promise<void> {
  scanning.value = true
  try {
    found.value = { ...found.value, [family]: await discoverWallets(family) }
  } finally {
    scanning.value = false
  }
}

onMounted(() => FAMILIES.forEach((entry) => void scan(entry.family)))

async function connect(wallet: WalletAdapter): Promise<void> {
  connecting.value = wallet.id
  try {
    await store.connect(wallet)
    ElMessage.success(`${wallet.label} 已连接`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    connecting.value = null
  }
}
</script>

<template>
  <div class="bar">
    <div class="bar__brand">合约管理平台</div>

    <div class="bar__spacer" />

    <el-tag v-if="store.operator" type="success" effect="plain">
      {{ store.operator.label }}
    </el-tag>

    <el-dropdown
      v-for="entry in FAMILIES"
      :key="entry.family"
      trigger="click"
      @command="connect"
      @visible-change="(open: boolean) => open && scan(entry.family)"
    >
      <el-button
        :type="store.connected[entry.family] ? 'success' : 'primary'"
        :loading="connecting !== null && found[entry.family].some((w) => w.id === connecting)"
        plain
      >
        {{ entry.label }}
        <template v-if="store.connected[entry.family]">
          · {{ shorten(store.connected[entry.family] ?? '') }}
        </template>
        <el-icon class="el-icon--right"><ArrowDown /></el-icon>
      </el-button>

      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="wallet in found[entry.family]" :key="wallet.id" :command="wallet">
            <div class="wallet">
              <img v-if="wallet.icon" :src="wallet.icon" class="wallet__icon" alt="" />
              <span class="wallet__label">{{ wallet.label }}</span>
              <el-tag
                v-if="store.wallets[entry.family]?.id === wallet.id"
                size="small"
                type="success"
                effect="plain"
              >
                已连接
              </el-tag>
            </div>
          </el-dropdown-item>

          <el-dropdown-item v-if="found[entry.family].length === 0" disabled>
            {{ scanning ? '检测中…' : `没有检测到 ${entry.label} 钱包` }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>

    <el-button v-if="store.operator" text @click="store.disconnect">断开</el-button>
  </div>
</template>

<style scoped>
.wallet {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 160px;
}
.wallet__icon {
  width: 18px;
  height: 18px;
  border-radius: 4px;
}
.wallet__label {
  flex: 1;
  font-size: 14px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 100%;
  padding: 0 20px;
  border-bottom: 1px solid var(--el-border-color-light);
}
.bar__brand {
  font-weight: 600;
  font-size: 16px;
}
.bar__spacer {
  flex: 1;
}
</style>
