import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useCatalog } from './catalog'
import { useExecution } from './execution'
import { useSession } from './session'
import type { WalletAdapter } from '../chain'

/**
 * 唯一的 store，由三块组合而成：
 *
 *   session    身份与签名方式（谁在操作、用什么签）
 *   catalog    配置目录与链上状态（能看到什么、现在什么状态）
 *   execution  批量执行与进度事件（正在做什么、结果如何）
 *
 * 组件不直接调 api，全部经过这里 —— 状态只有一处可变，调试与测试都简单。
 * 跨块的调用只在这个文件里发生，三块之间不互相 import。
 */
export const useStore = defineStore('operator', () => {
  const session = useSession()
  const catalog = useCatalog(session)
  const execution = useExecution(catalog, session)

  const error = ref<string | null>(null)

  async function connect(wallet: WalletAdapter): Promise<void> {
    error.value = null
    // 只有 EVM 会真的登录；登录成功了才去拉数据
    if (await session.connect(wallet, disconnect)) {
      await catalog.bootstrap()
      return
    }

    /**
     * 走到这儿说明这次连接没触发登录：连的是 Tron（不参与登录），
     * 或者已经登录过了。数据已经加载过的话要**重读一次状态** ——
     * 多了一个链族的地址，那个链族的 isOperator 才问得出来。
     * 没加载过就什么都不做：还没有配置可读，白发一轮 RPC。
     */
    if (catalog.registry.value) await catalog.refreshStates()
  }

  /** 退出：反向拆 —— 先停执行，再清数据，最后清身份 */
  function disconnect(): void {
    execution.resetExecution()
    catalog.resetCatalog()
    session.resetSession()
  }

  return { ...session, ...catalog, ...execution, error, connect, disconnect }
})
