<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useStore } from '../store'
import { shorten } from '../chain/wallet'
import type { ChainFamily } from '../types'

/** 顶栏：连接 EVM / Tron 钱包。首个连上的钱包用于签名登录换 JWT */
const store = useStore()
const connecting = ref<ChainFamily | null>(null)

async function connect(family: ChainFamily) {
  connecting.value = family
  try {
    await store.connect(family)
    ElMessage.success(`${family.toUpperCase()} 钱包已连接`)
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

    <el-button
      v-for="family in (['evm', 'tron'] as ChainFamily[])"
      :key="family"
      :type="store.connected[family] ? 'success' : 'primary'"
      :loading="connecting === family"
      plain
      @click="connect(family)"
    >
      {{ family === 'evm' ? 'EVM' : 'Tron' }}
      <template v-if="store.connected[family]">
        · {{ shorten(store.connected[family]!) }}
      </template>
    </el-button>

    <el-button v-if="store.operator" text @click="store.disconnect">断开</el-button>
  </div>
</template>

<style scoped>
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
