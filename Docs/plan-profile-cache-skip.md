# 计划：profile 缓存跳过与清理（AIGC-pipeline）

> 状态：已完成
> 背景：`.chromium-profile` 实测 **1.34 GB**，其中缓存占 1.32 GB：
>
> | 目录 | 体积 |
> |---|---|
> | `Default/Cache` | 929.5 MB |
> | `Default/Service Worker` | 237.4 MB |
> | `Default/Code Cache` | 102.5 MB |
> | `WasmTtsEngine` | 24.5 MB |
> | `OnDeviceHeadSuggestModel` | 7.6 MB |
> | `GPUPersistentCache` | 6.3 MB |
>
> 真正需要保留的登录数据（`Default/Cookies`、`Local Storage`、`IndexedDB`）只有 ~12 MB。
> 同一套逻辑已在 VideoRogo 落地（506 MB → 5.8 MB），这里移植过来。

---

## 1. 目标

1. 克隆系统 profile 时**不拷**缓存/遥测目录。
2. 已有 profile 在**冷启动时**清一次缓存，登录态不丢。
3. 运行中的浏览器**绝不**被清理（避免破坏正在跑的 harvest）。
4. 提供手动命令：`aigc profile size` / `aigc profile clean [--dry-run] [--force]`。
5. 限制缓存重新增长：`--disk-cache-size=64MB`。

---

## 2. 新增文件

### `src/libs/browser/profile-cache.ts`

| 导出 | 作用 |
|---|---|
| `PROFILE_SKIP_DIRS` | 克隆时跳过、清理时删除的缓存/遥测目录白名单（Cache / Code Cache / Service Worker / GPUCache / Dawn* / BrowserMetrics / Crashpad / WasmTtsEngine / blocklists …） |
| `PROFILE_IGNORE_FILES` | 锁文件、`*.pma`、`chrome_debug.log` |
| `pruneProfile(dir, { force, dryRun })` | 递归删除上述目录，返回 `{ removedDirs, removedFiles, freedBytes, remainingBytes, skipped, pid }` |
| `profileInUse(dir)` | 读 `SingletonLock`（`<hostname>-<pid>`）或 `.browser-session.json` 判断是否仍有 Chromium 存活 |
| `dirSizeBytes` / `formatBytes` | 体积统计与展示 |

**保留清单（关键）**：`Cookies`、`Network`、`Local Storage`、`IndexedDB`、`Session Storage`、
`Preferences`、`Login Data`。运行时文件 `SingletonLock/SingletonCookie/SingletonSocket/LOCK`
与 `.browser-session.json` 在清理时也保留（活进程可能还持有）。

---

## 3. 修改点

| 文件 | 修改 |
|---|---|
| `src/utils/browser.ts` | `copyProfileDir()` 跳过 `PROFILE_SKIP_DIRS`；`ensureProfileDir()` 已有 profile 时调用 `pruneProfile()`（被占用则跳过并提示）；克隆/重置后打印体积 |
| `src/libs/browser/launcher.ts` | 冷启动 spawn 前 `pruneProfile()`；默认参数加 `--disk-cache-size=67108864` |
| `src/libs/browser/real-chrome-launcher.ts` | 同上（扩展版启动器，复用同一 profile） |
| `src/libs/browser/cli.ts` | 新增 `clean-profile` 命令（`-p/--profile-dir`、`--force`、`--dry-run`） |
| `src/libs/browser/index.ts` | 导出 profile-cache API |
| `src/cli.ts` | 新增 `aigc profile size` / `aigc profile clean`，默认帮助里列出 `profile` |

---

## 4. 安全策略

- `pruneProfile()` 默认检测 `profileInUse()`；检测到活进程 → `skipped: true`，返回 pid 与当前体积。
- 只有 `--force` 才会在浏览器运行时清理。
- 清理点只在**冷启动**（spawn 之前），不在复用会话时。
- 清理永远不动 cookies / Local Storage / IndexedDB / Preferences。

---

## 5. 验证

1. `npx tsc --noEmit` → 0 error；`npm run build` → 成功 ✅
2. `node dist/cli.js profile size` → 正确列出 1.34 GB 与 top 目录 ✅
3. 浏览器运行中 `profile clean` → `Skipped ... (pid 89748)`，退出码 2 ✅
4. `profile clean --force --dry-run` → `Would free 1327.7 MB (remains 14.2 MB)` ✅
5. 临时 profile 功能测试：`Default/Cache`、`Default/Service Worker`、`Code Cache`、`WasmTtsEngine` 被删；
   `Cookies`、`Local Storage`、`IndexedDB` 保留 ✅
6. `copyProfileDir()` 临时目录测试：只拷 2 个文件（Cookies + Local Storage），缓存与 `SingletonLock` 被跳过 ✅

---

## 6. 待办（需要人手动执行）

当前 `aigc flowTutor` 正在跑，Chromium（pid 89748）持有 profile，所以**没有**真正清理那 1.34 GB。
等 pipeline 结束后执行：

```bash
# 只清理、不动登录
node dist/cli.js profile clean          # 或 pnpm aigc profile clean

# 浏览器还开着且确认无影响时
node dist/cli.js profile clean --force
```

下次冷启动时 `launcher.ts` 也会自动清一次；重启后的浏览器受 `--disk-cache-size=64MB` 限制，
不会重新长回 GB 级。
