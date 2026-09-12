# J-Space Workspace Ledger

## Goal
检修 dsh-music-player（代码/依赖/打包/集成状态）并核实 dsh-router-standard 是否启用；产出可验证结论，低风险问题当场修复

## Core
- 路由器状态与插件基线 — 定义事实：router-standard 是当前默认 agent preset，插件线上 112 首曲目可正常播放

## Verified
- ✓01 服务器冒烟通过：临时 WAV 库 library 200、stream 200 与 206、416、越界 403、无封面 404 — verified by: 真实 http.Server 冒烟脚本，n=1 临时库，覆盖 5 条路由
- ✓02 router-standard 已启用：settings.yaml agent-presets.default=standard；dev_router_status 显示 router-mode=standard 且 override=no；预设安装在 ~/.dsh/.agent-presets — verified by: dev_router_status + settings.yaml + directory listing, across all agent-presets entries
- ✓03 插件基线：node --check 两个 lib 文件通过；git 工作区干净（仅 .jspace）；HEAD 与 origin/main 同为 a71336e；标签 v0.1.0/0.2.0/0.3.0 齐全；npm audit 0 漏洞 — verified by: Node 22 --check, git rev-parse, npm audit across all dependencies
- ✓04 线上集成正常：127.0.0.1:3080 /dsh-music/api/library 返回 200，112 首 flac/mp3，scanning=false — verified by: HTTP probe of one live route including status and payload fields
- ✓05 collectAudioFiles 修复：扫描因 20000 访问上限提前退出时置 truncated=true — verified by: 构造 20001 子目录的回归冒烟，n=1 临时库，轮询至扫描结束，truncated=true
- ✓06 restoreLastPlayed 修复：仅在无 last 或成功回补后置位，last 不在当前库时保留重试机会 — verified by: code review across all affected lines + Node 22 --check on both lib files
- ✓07 v0.3.1 发布就绪：package.json/package-lock 0.3.1，修复提交 e4d6dc3，tag v0.3.1，tgz 与工作区逐文件一致；未推送 — verified by: git show + tar unpack diff, across all 6 packaged files
- ✓08 推送完成：main a71336e→cfacb9a（fix e4d6dc3 + docs cfacb9a），tag v0.3.1 已在 GitHub — verified by: git push output + git ls-remote check across all refs
- ✓09 一键安装可行且已验证：dsh plugin add github: 在全新 profile 自动初始化、装依赖（含 music-metadata）、自动注册 bundles；remove 自动摘除 — verified by: throwaway DSH_HOME fixture end-to-end test, including install and remove, all steps
- ✓10 播放顺序修复并发布 v0.3.2：visibleRows 成为渲染与播放推进的唯一顺序源，已推 GitHub（main + tag） — verified by: Node stub tests, 9 cases across sort asc/desc, filter, prev 3s rule, ended, toggle — all pass; tarball diff across all 6 packaged files
- ✓11 删除功能完成并发布 v0.3.3：行首 − 按钮 + 确认框，确认后删除本地文件；服务端越界/重复删/非法 JSON 均防护 — verified by: server smoke 10 cases + client stub 10 cases + order regression 3 cases, all pass; tarball diff across all 6 packaged files

- ✓12 代码审计与修复（工作树，未提交）：安全 5 项（封面 mime 白名单 + 8MB/32MB 双限 + nosniff；回环 Host/同源栅栏阻止跨站 POST 与 DNS rebinding；畸形 URI 400；`~` 展开；不再泄漏 cwd）、逻辑 4 项（刷新扫描期间列表不消失并按 id 重映射、loadedmetadata 竞态不再劫持新曲、插件卸载后自动续播定时器失效、换库清 pendingDelete/coverKnown）、性能 3 项（同目录刷新复用 + 取消扫描；封面缓存按字节封顶；卸载取消在飞扫描） — verified by: 10 套 npm test 全绿（含新增 6 套）+ pre/post A/B（刷新×4 CPU 3.71x→1.07x；144MB 封面驻留 150MB→36MB；卸载残留 CPU 224-304ms→6-62ms）+ 隔离 DSH_HOME 真实 `dsh web` 实例端到端 7 项全过
- ✓13 测试可复现：package.json 增加 `npm test` 与 devDependencies（jsdom/react/react-dom），package-lock 同步（原先测试依赖仅为跨仓库软链，`npm ci` 后无法运行） — verified by: npm install --package-lock-only 一致性校验 + node scripts/run-all.mjs

- ✓14 死代码清理：移除库接口中从未被消费的 `tracks[].index`/`mime` 字段（每次轮询都计算+序列化）；删除测试里只写不读的 `routeDisposer`、无用的 `options` 参数，接口占位参数改 `_meta/_name`；preview-server 无请求路径的 `.css/.json` MIME 项删除；test-resume 由「只打印」改为断言（此前恒 exit 0，等于死测试）。tsc --noUnusedLocals/--noUnusedParameters 与 CSS/locale/icon 全量引用扫描均无命中 — verified by: tsc unused 扫描 0 命中，npm test 10/10 全绿

## Open
- ?03 ~/.npm 缓存含 root 属主文件，npm pack 默认缓存 EPERM — settled by: sudo chown 后 npm pack 默认缓存成功
- ?04 平台级：插件前缀路由不经过 /api browser-trust fence（已在本插件内自建同款回环/同源栅栏）— 其他 prefix 插件仍暴露于跨站/rebinding，需上游统一处理

## Next
验收后提交/发版（当前改动未 commit）；客户端改动需 `dsh web` 重启或 HMR 才会进入浏览器
