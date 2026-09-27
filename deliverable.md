# 跳蛙渡 - 交付报告

## 摘要

| 字段 | 值 |
|---|---|
| **App 名称** | 跳蛙渡 |
| 英文名 / 仓名 | LEAP · `z-biz-game-leap-cos` |
| 玩法一句话 | 一条河两岸各站 n 只蛙，只能朝前一步或跳过恰好一只对岸的蛙落在空格上，要求整体换岸 |
| `par` 的来源 | 该河段**全部可达局面**的 BFS 最短距离（`js/core/solve.js:solveBoard`），并由带记忆 DFS 与闭式 `ab+a+b`（两岸齐平时 `n(n+2)`）两条独立路复算 |
| 难度的来源 | 同一个 `par`。带（shoal/linked/twined/master）按实测 `par` 划，不是星级也不是字符串标签 |
| 外部锚点 | n=1..5 = `3,8,15,24,35`；n=6..9 = `48,63,80,99`；最优路线数 = 2（n=1..6）；开局合法走法 = 2 —— 四条全部由测试复现，期望值手写死在 `test/solve.test.mjs` |
| 出货内容 | 40 段河（每带 10 段），33 个不同 `par`，3–80 步；其中 15 段两岸齐平、16 段不对称 |
| 依赖数 | 0（`dependencies` 与 `devDependencies` 均为 `{}`；`npm run check` 不装任何东西） |
| 二进制资产 | 0（画面全部 canvas 2D 程序绘制，favicon 是内联 SVG data-URI） |
| node 层 | 6 套件 / 90 用例 / 2388 断言 / fail 0 |
| 浏览器层 | 6 段（@boot @play @routes @save @reloaded @pointer）/ 116 用例 / fail 0，console 干净 |
| 验收 | `bash tools/verify.sh` → `=== ALL GREEN ===`（输出行见下） |
| 未做 | 规格 §4 的 `steps > par` 提示（实测不可达，见改动表第 4 行）；n>8 关卡；成就/排行/内购/云存档 |

## 文件清单与验证者

| 文件 | 作用 | 由谁验证 |
|---|---|---|
| `js/core/rng.js` | `hashSeed`（FNV-1a **派生**的两轮 UTF-16 混合）+ `mulberry32`，与 gridlock-cos 逐字相同 | `node test/rng.test.mjs`（7 用例 / 207 断言，含"不等于教科书 FNV-1a"的反向断言） |
| `js/core/game.js` | 规则的唯一实现：状态编解码、序列化校验、合法走法、困水、退回、星星 | `node test/rules.test.mjs`（22 / 844） |
| `js/core/solve.js` | BFS 可达集、倒着走的距离表、带记忆 DFS、闭式 `ab+a+b` / `n(n+2)`、锚点表 | `node test/solve.test.mjs`（24 / 337） |
| `js/core/make.js` | 出题：沿"仍可解"的边走 k 步，再交给搜索量；带定义与形状校验 | `node test/make.test.mjs`（11 / 771） |
| `js/core/library.js` | 出货关卡的门：从序列化之后的行重解，复现不上就是错误；每日/随机查表 | `node test/library.test.mjs`（15 / 164） |
| `js/core/storage.js` | 守卫式存档（`js/core` 里唯一碰浏览器全局的文件），`best` 只降、`unlocked` 只升 | `node test/storage.test.mjs`（11 / 59）+ `bash tools/verify.sh` 的 purity 门 |
| `js/data/lots.js` | 40 段出货河，每行的 `par/optimalPaths/states` 都是量出来的 | `node tools/bake.mjs` 第 3、4 道门 + `node test/library.test.mjs` 第 1 条断言 |
| `js/view.js` | canvas 2D 程序绘制 + 点/拖手势；不判断合法性 | `bash tools/verify.sh` 的 `@pointer`（32 用例，真 `Input.dispatchMouseEvent`）与 `@boot` 的画布盒子断言 |
| `js/main.js` | 路由、面板、演示、存档、`window.leap` 钩子 | `@boot @play @routes @save @reloaded` 四段全部通过该钩子驱动 |
| `index.html` | 骨架与内联 SVG favicon | `@boot`（每个 id 都被 `@pointer` 第一条断言点名）+ `verify.sh` 的 console-clean 门（`href="data:,"` 会留 404，这里不会） |
| `css/game.css` | 画布盒子尺寸（`aspect-ratio` + `min-height`）与面板样式 | `@boot` 的 "the canvas is laid out, not the unstyled 300x150 default" |
| `tools/bake.mjs` | 构建期四道门：锚点 → 生成器实测 → 逐行重解 → 写文件后再 import 回来过 `validateLot` | `node tools/bake.mjs`（本报告"数字从哪来"就是它的输出） |
| `tools/harness.mjs` | 微型测试框架，node 与浏览器套件输出形状一致（`rows/fail/asserts`） | 每个 `test/*.test.mjs` 与每个 `@scenario` 都用它/它的形状 |
| `tools/playtest.mjs` | 零依赖 CDP 驱动：`waitShell()` 轮询、真鼠标、拖拽、截图、console | `bash tools/verify.sh`（它自己不被断言，由 verify.sh 的每段 rows 证明可用） |
| `tools/verify.sh` | 一次性验收门：端口预检、`mktemp -d` profile、双就绪轮询、purity 门、花括号截 JSON、`trap cleanup EXIT` | `bash tools/verify.sh` 末行 `=== ALL GREEN ===`；跑完 `pgrep -f remote-debugging-port=9356` 为空 |
| `server.cjs` | 零依赖静态服务器（ES module 需要 origin） | `verify.sh` 的 web 根目录就绪轮询 + 浏览器套件全部请求经它 |
| `electron/main.cjs` | 打包把手（复用 `server.cjs`，port 0） | `npm run check`（`node --check`）；`electron` 不是依赖，故无运行断言 |
| `package.json` | 脚本与零依赖声明 | `npm run check`、`node -e` 读 `dependencies` 为 `{}` |
| `test/*.test.mjs`（6 个） | node 层断言 | `node --test test/` → `pass 6 fail 0` |
| `.github/workflows/ci.yml` | unit job（`node --check` 全量 + 每个套件）+ browser job（`SKIP_UNIT=1`） | 步骤集合与 `npm run check` 完全一致（同一串 glob）；browser job 就是本机跑绿的 `verify.sh` |
| `.github/workflows/pages.yml` | 文件拷贝式部署：只 `cp index.html css js` | 人工核对：`index.html` 只引用 `css/game.css`、`js/main.js`，`js/**` 全在拷贝范围内；无 `path: .` |
| `README.md` / `DESIGN.md` | 玩法+复现命令 / 面向维护者的取舍与坑 | 表里的数字与 `node tools/bake.mjs` 输出逐条对照（下节即其原文） |
| `.gitignore` / `LICENSE` | 忽略项与 MIT（Copyright (c) 2026 z-biz-game） | 人工核对（无代码断言） |

## 数字从哪来

`node tools/bake.mjs` 的真实输出（本机，2026-09-27；结构量逐位可复现，`ms` 是计时量会随负载漂）：

```
anchors: n=1 par=3 paths=2 states=6 | n=2 par=8 paths=2 states=23 | n=3 par=15 paths=2 states=72 | n=4 par=24 paths=2 states=195 | n=5 par=35 paths=2 states=476 | n=6 par=48 paths=2 states=1089 | n=7 par=63 paths=2 states=2388 | n=8 par=80 paths=2 states=5093 | n=9 par=99 paths=2 states=10662
anchors: BFS = DFS = n(n+2) on n=1..9, asymmetric ab+a+b on 36 shapes, 302 ms
rule check: n=3 standard par 15 / 2 routes, letting a frog clear two pads gives par 15 / 174 routes
generator shipped: 960 lots requested, 1614 proposals, 960 accepted = 59.48% of proposals, 66.77% accepted on the very first try
  rejects: par outside band 654, dead water 0, illegal shape 0; search 3.678 ms per measured lot, worst single search 85 ms, largest reachable set searched 5093 positions
generator naive : 960 lots requested, 5560 proposals, 960 accepted = 17.27% of proposals, 28.96% accepted on the very first try
  rejects: par outside band 459, dead water 4141, illegal shape 0; search 5.642 ms per measured lot, worst single search 70 ms, largest reachable set searched 5093 positions
wrote 40 lots (shoal:10 linked:10 twined:10 master:10) -> js/data/lots.js
bands shipped: shoal 3-8 (10 lots, 4 bank-to-bank, 5 uneven) | linked 10-24 (10 lots, 4 bank-to-bank, 3 uneven) | twined 28-48 (10 lots, 3 bank-to-bank, 1 uneven) | master 53-80 (10 lots, 4 bank-to-bank, 7 uneven)
re-solve gate: 40 serialised rows re-solved and accepted
total bake time 9271 ms
```

每带 `par` 范围（出货值，非生成包络）：shoal 3–8、linked 10–24、twined 28–48、master 53–80；
`HISTOGRAM` 里 33 个不同 `par`、min 3、max 80；`deadEnds` 最大 1184（master 带的一段 8/8 河）。

复现命令：

```
node tools/bake.mjs
```

（同一份代码 + 同一份种子会写出**逐字节相同**的 `js/data/lots.js`：本机连跑 `node tools/bake.mjs`
三次，产物 md5 三次都是 `f3b389e6cb498a4f89fc40441d99dafb`。这是刻意做成这样的——机器相关的
`msPerLot` 一类计时只打印到 stdout、不写进产物，否则任何一台机器重跑都会改写一份出货文件，
"产物复现自己印着的数字"就没法用校验和来查了。`PER_BAND=24 PROBE=2000 node tools/bake.mjs`
可以要更长的一份，那一版自然会有不同的行。）

## 改动表（先写错在哪 → 为什么对）

| 曾经的错误 | 错在哪 | 为什么现在是对的 | 证据 |
|---|---|---|---|
| 把 `countOptimalDFS` 的"到不了对岸"记成 `null` | JS 里 `null + 1 === 1`，于是 n=2 的河被第二条路报成 2 步（BFS 说 8） | 内部一律用 `Infinity` 传播，只在出口转成 `null`；三路对账（BFS / DFS / 闭式）必须逐位相同才放行 | `test/solve.test.mjs` 'the memoised DFS … reproduces par independently'，期望值写死为 `3,8,15,24,35,48` |
| `applyMove` 不接受规则参数 | "允许连跳两只"的反证用例在 `forwardReach` 里抛 `illegal move 4->1`：反证需要第二套规则，参数就必须一路传到底 | `applyMove(board, move, opts)`，`play()` 传 `game.rules`，`tableRoute` 传 `table.rules` | `test/solve.test.mjs` 'refutation: let a frog clear two pads and n=3 changes shape'（`par 15 / 2 条` → `par 15 / 174 条`） |
| 序列化里省掉 `cells`、只留 `11022` 串 | 紧凑但"重叠/越界/缺空格"没有对照物，负例无从下手，手改产物也没门可过 | 每行同时带 `cells`、`left[]`、`right[]`、`empty`，四者必须自洽；四类负例各一条 | `test/library.test.mjs` 的 4 条 re-solve 门断言 + `test/rules.test.mjs` 的 validator 断言 |
| 按规格实现"`steps > par` 时印未达下界" | 这个分支在本玩法里**数学上不可达**：n=1..6 全部可达局面上逐边量过，每条合法走法要么刚好花掉一个单位距离、要么让对岸永不可达 ⇒ 能到对岸必然等于 `par` | 保留 `overPar`（困水时返回 `null`），把赢card的第二档改成两个真会变的实测计数 `hints` / `strands`；规格那句被替换为真实存在的失败模式"困水"（面板印"困"而不是编一个距离） | `test/solve.test.mjs` 'the chain theorem…'（可解局面 = `2·n(n+2)` = 6/16/30/48/70/96）与 'so there are exactly two complete solutions…'；`@play` '每落一步刚好花掉一个单位的最短距离'；`@pointer` 'a hop into dead water is billed and reported' |
| 出题用朴素随机游走 | 接受率实测 **17.27%**（5560 次提案里 4141 次因为"这一步把河跳死了"被丢），低于契约的 20% 线 | 改成沿"距离表仍认为可解"的边走，接受率 59.48%、`rejectDead` 归零；两行实测都留在输出里，没有藏起被替换的那一版 | `node tools/bake.mjs` 的 `generator shipped` / `generator naive` 两行；`test/make.test.mjs` 'the generator bills what it rejects' |
| purity 门 `grep "window\."` 扫全部 core | storage.js 的**注释**里解释了"为什么不用 `window.localStorage`"，于是门把散文当代码，把好文件判红 | 只匹配代码位置（行首注释标记排除掉），并额外用一条 fixture 自证"这个模式还能抓到真的违规" | `bash tools/verify.sh` 的 `=== purity gate ===` 两行输出 |
| 空闲时让可动的蛙"呼吸"（正弦微动） | 画布每帧都不同，`pixelsHash()` 不再是局面的指纹，"被拒的一下什么都没留下"这句根本没法断言（首轮 @pointer 两条 FAIL 就是这么来的） | 去掉空闲动画：画面是"局面 + 一个瞬态（弧线/抖动/提示环）"的纯函数，静止 4 帧之后不再重绘 | `@pointer` 'a refused tap leaves nothing behind' 与 'undo takes the step back and the river back with it' 现在都绿 |
| `@play` 里为了测"下一关按钮"中途 `#/c/1` | 把页面切到 par=3 的 shoal-01，后面所有按 `par = 8` 写的断言全成假故障（首轮 8 条 FAIL） | 该块移到套件最后，中间不再换关；顺带把"分享的河段没有下一关按钮"单独钉成一条 | `@play` 25 rows / fail 0 |
| `@pointer` 里对页面返回值再 `JSON.parse` | `Runtime.evaluate` 已经按值返回对象，再 parse 得到 `"[object Object]" is not valid JSON`，整段直接崩 | 页面侧统一 `JSON.stringify(...)` 回传、Node 侧只在拿到字符串时 parse | `@pointer` 32 rows / fail 0 |
| 生成器的耗时被写进 `js/data/lots.js` 的 `MEASURED` | 产物文件里带着 `msPerLot`/`worstMs`，于是换台机器（甚至同一台机器换个负载）重跑 bake 就会改写一份出货文件；"数据复现印着的数字"这句话当场失去意义 | 结构量（锚点表、规则反证、每带实测范围）留在文件里，计时量只打印；`test/library.test.mjs` 现在断言 `MEASURED` 里**没有** `ms` 这个字串，并逐带核对 `shipped` 范围 |
| 把 `hashSeed` 当教科书 FNV-1a 断言 | 它是 FNV-1a **派生**的两轮混合：`hashSeed('a') = 723832900`，教科书给 `3826002220`；拿公开向量当"应等于"会一路红 | 测试同时算两个值并断言它们**不相等**，其余全是自洽断言（同种子两次相等、32 位内、分布合理） | `node test/rng.test.mjs` 'hashSeed is an FNV-1a *derived* two-round mixer, not FNV-1a' |

## 验收结论

```
$ npm run check
OK

$ for f in test/*.test.mjs; do node "$f" | tail -1; done
test/library.test.mjs    rows: 15 fail: 0 asserts: 170
test/make.test.mjs       rows: 11 fail: 0 asserts: 771
test/rng.test.mjs        rows:  7 fail: 0 asserts: 207
test/rules.test.mjs      rows: 22 fail: 0 asserts: 844
test/solve.test.mjs      rows: 24 fail: 0 asserts: 337
test/storage.test.mjs    rows: 11 fail: 0 asserts:  59

$ node --test test/
ℹ tests 6   ℹ pass 6   ℹ fail 0

$ SKIP_UNIT=1 bash tools/verify.sh
=== purity gate ===
  js/core/* touches no window/document
boot lot: shoal-01
=== @boot ===      rows: 16 fail: []
=== @play ===      rows: 25 fail: []
=== @routes ===    rows: 23 fail: []
=== @save ===      rows: 14 fail: []
=== @reloaded ===  rows:  6 fail: []
=== @pointer ===   rows: 32 fail: []
=== console ===
(none)
=== ALL GREEN ===

$ pgrep -f "remote-debugging-port=9356"      # 跑完之后：空
$ lsof -nP -iTCP:5196 -sTCP:LISTEN           # 空（没有残留 server）
```

浏览器层合计 116 用例（要求 ≥ 40），node 层 90 用例 / 2388 断言（要求 ≥ 45 断言）。
截图：`/tmp/puzzle-brief/shots/leap-boot.png`（开局）、`/tmp/puzzle-brief/shots/leap-pointer.png`（真鼠标走完之后的中段状态）。
`verify.sh` 本机共跑 4 次：前 3 次各红若干条，全部是**测试自身的流程/期望错误或视图的抖动**
（见改动表 6–9 行），修好后 `=== ALL GREEN ===`；第 4 次是在把计时量移出 `js/data/lots.js` 之后
重跑确认。没有放宽任何断言，也没有为了变绿删过一条测试。

## 未实现清单

1. **规格 §4 的 `steps > par` 文案未实现**（数学上不可达，见改动表第 4 行）。替换成同一屏上真实存在的
   失败模式：困水（`距对岸` 那一格印"困"，提示会承认帮不上，只能退回）。
2. **`n > 8` 的关卡不发布**（规格 §6）。`tools/bake.mjs` 仍把 n=9 的锚点算出来做闭式对账，但 `MAX_BANK`/`MAX_CELLS` 与各带的 `tier.sizes` 把出货宽度钉在 17 格，`test/make.test.mjs` 有 `validateShape(9, 9)` 的负例。
3. **没有"防困水"确认弹窗**：一步合法但致命的走法不会被拒绝，只会被如实记账并画清楚。刻意不做。
4. **`electron/` 只过 `node --check`，没有运行断言**：`electron` 不是依赖（零依赖不许破），
   桌面壳的实跑由打包阶段负责，本机没跑过。
5. **每日题只覆盖"两岸齐平"的形状**（`dailyLot` → `canonicalLot(n,n)`），因为那是闭式能说话的位置；
   不对称河与中段河只在战役与 `#/random` 里出现。规格 §3 只要求每日题选 `(n, 显示参数)`，未偏离。
6. **没有做移动端触摸的独立台架段**：`@pointer` 走的是 CDP 鼠标事件（`touch-action: none` 已设），
   真机手指未验证。
