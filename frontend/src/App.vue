<script setup lang="ts">
import { useStore } from './store'
import AppSidebar from './components/AppSidebar.vue'
import WalletBar from './components/WalletBar.vue'
import ContractList from './components/ContractList.vue'
import OperationLog from './components/OperationLog.vue'
import GpgProgress from './components/GpgProgress.vue'

/**
 * 整体布局：
 *   顶栏连钱包 ｜ 左侧选业务线 ｜ 中间 tab + 合约列表 ｜ 下方操作日志
 */
const store = useStore()
</script>

<template>
  <el-container class="app">
    <el-header class="app__header" height="56px">
      <WalletBar />
    </el-header>

    <el-container class="app__body">
      <el-aside width="200px">
        <AppSidebar />
      </el-aside>

      <el-container direction="vertical" class="app__main">
        <el-main v-if="store.operator" v-loading="store.loading" class="app__content">
          <ContractList />
        </el-main>

        <el-main v-else class="app__welcome">
          <el-empty description="请先连接钱包并签名登录">
            <div class="app__hint">只有白名单内的地址可以登录</div>
          </el-empty>
        </el-main>

        <OperationLog v-if="store.operator" />
      </el-container>
    </el-container>

    <!-- GPG 执行进度：执行期间挡住界面，把每一步展开给用户看 -->
    <GpgProgress v-if="store.operator" />
  </el-container>
</template>

<style scoped>
.app {
  height: 100vh;
}
.app__header {
  padding: 0;
}
.app__body {
  min-height: 0;
}
.app__main {
  min-height: 0;
}
.app__content {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.app__welcome {
  display: flex;
  align-items: center;
  justify-content: center;
}
.app__hint {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
</style>
