/**
 * 用量模块入口。
 *
 * 实现都在 `./usage/store.js`；本文件只做转出，保留 `src/usage.js` 这个既有导入路径，
 * 避免"同一个东西两处实现"——`createRequestLog` 曾在这里定义，现已与 `UsageStore` 同处，
 * 两者共享同一份字段口径（`num()` / `nullableNum()`）。
 */
export { UsageStore, createRequestLog } from './usage/store.js'
