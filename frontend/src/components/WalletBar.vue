<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useStore } from '../store'
import { ArrowDown } from '@element-plus/icons-vue'
import { allWallets, shorten } from '../chain/wallet'
import type { ChainFamily } from '../types'

/**
 * 顶栏钱包区：一个「连接钱包」按钮 + 下拉，点哪个连哪个。
 *
 * EVM 和 Tron 一视同仁 —— 都是注册表里的一项，加新链族时
 * wallet.ts 的 ADAPTERS 加一行，这里自动多一项，不用改组件。
 *
 * 只有 EVM 参与登录（身份就是一个 EVM 地址）；Tron 连上只是为了
 * 在钱包模式下给 Tron 合约发交易。下拉里会标出来，免得用户
 * 连了 Tron 却发现没登录进去。
 */
const store = useStore()
const connecting = ref<ChainFamily | null>(null)

/**
 * 「装没装插件」不是响应式的 —— 用户装好插件或解锁钱包后不刷新页面，
 * 下拉里会一直显示"未安装"。每次打开下拉时 +1，强制重新探一遍。
 */
const probe = ref(0)

interface WalletOption {
  family: ChainFamily
  label: string
  installed: boolean
  address: string | null
  /** 是否用于签名登录 */
  signsIn: boolean
}

const options = computed<WalletOption[]>(() => {
  void probe.value // 依赖它，打开下拉就重算
  return allWallets().map((wallet) => ({
    family: wallet.family,
    label: wallet.label,
    installed: wallet.isInstalled(),
    address: store.connected[wallet.family] ?? null,
    signsIn: wallet.family === 'evm',
  }))
})

const connected = computed(() => options.value.filter((option) => option.address))

async function connect(option: WalletOption): Promise<void> {
  if (!option.installed) {
    ElMessage.warning(`未检测到${option.label}，请先安装浏览器插件`)
    return
  }
  connecting.value = option.family
  try {
    await store.connect(option.family)
    ElMessage.success(`${option.label}已连接`)
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

    <!-- 已连上的钱包，一个一枚，看得见现在在用哪些 -->
    <el-tag v-for="option in connected" :key="option.family" type="info" effect="plain">
      {{ option.label }} · {{ shorten(option.address ?? '') }}
    </el-tag>

    <el-dropdown trigger="click" @command="connect" @visible-change="probe += 1">
      <el-button type="primary" plain :loading="connecting !== null">
        连接钱包<el-icon class="el-icon--right"><ArrowDown /></el-icon>
      </el-button>

      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item v-for="option in options" :key="option.family" :command="option">
            <div class="wallet">
              <span class="wallet__label">{{ option.label }}</span>
              <el-tag v-if="option.address" size="small" type="success" effect="plain">
                {{ shorten(option.address) }}
              </el-tag>
              <el-tag v-else-if="!option.installed" size="small" type="info" effect="plain">
                未安装
              </el-tag>
              <el-tag v-else-if="option.signsIn" size="small" type="warning" effect="plain">
                登录用
              </el-tag>
            </div>
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
  justify-content: space-between;
  gap: 12px;
  min-width: 180px;
}
.wallet__label {
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
