import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 并发/IO 类测试在负载高的机器（或有杀毒实时扫描、机械盘）上会明显变慢：
    // store 的并发写测试正常 1.7s 完成，机器繁忙时曾超过 20s。
    // 这些测试验证的是**正确性**（不丢更新、顺序确定），不是性能，
    // 故给足超时避免"慢机器假失败"；真正的死锁仍会被这个上限捕获。
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
