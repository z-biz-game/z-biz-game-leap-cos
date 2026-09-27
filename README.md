# 跳蛙渡 · LEAP

一条河，两岸各站 n 只蛙，要求整体换到对岸。蛙只会两种动作：**朝前落进紧邻的空莲叶**，或者
**跳过恰好一只对岸的蛙、落在它身后的空叶上**。不能倒退，不能连跳两只，不能跳出河外。

屏幕上每个步数都是量出来的：`par` 是这条河**全部可达局面**走完广度优先搜索得到的最短距离，
同一条路还由闭式公式和带记忆的深度优先搜索各自独立复算了一遍。这个仓的立意不是"这关很难"，
而是"这一关要 48 步"——一个可以被任何人用一条命令反驳的命题。

```
node tools/bake.mjs      # 出题 + 复验，并打印下面那张表的来源
node --test test/        # 90 个用例、约 2400 条断言，全绿
npm start                # http://127.0.0.1:5196/
```

## 玩法

* 点一只蛙 = 把它落到它唯一的合法落点（本玩法里一只蛙最多只有一个合法落点，所以不需要选菜单）。
* 按住拖到目标莲叶 = 同一件事的另一种手指说法。
* 发亮的蛙 = 现在能动的蛙；虚线 = 它会落到哪里。
* 蛙**只能朝前**：左岸的绿蛙只往右，右岸的褐蛙只往左。朝向已经画进眼睛里了。
* 提示（`h`）、退回（`u`）、演示（`d`）、重开（`r`）。

一条河的**合法走法总数与最短走法数相等**：任何一步只要不把离对岸的距离花掉一个单位，那条河
就永远到不了对岸（下面"数字从哪来"第三条会说这是在哪些局面上量出来的）。所以本游戏里没有
"我多走了两步才到对岸"这件事——要么刚好 `par` 步，要么就得按退回。星星数因此不数步数，
只数两件可复算的事实：你问过几次提示、把自己困在水里几次。

## 数字从哪来

一条河是 `2n+1`（或 `a+b+1`）个格子的串，状态就是这串 `1/0/2`。蛙只朝前 ⇒ 每走一步
"左岸蛙位置之和减去右岸蛙位置之和"必增 ⇒ **局面图是一个 DAG**，于是穷尽它是有界的。

三条独立的路，必须给出同一个数：

1. **BFS**（`js/core/solve.js` 的 `solveBoard`）：从这一关的起点把可达局面全部走完，读出终点的深度。
   n=1..9 的两岸齐平局面实测 `3, 8, 15, 24, 35, 48, 63, 80, 99`。
2. **闭式**（`formula(a,b) = ab + a + b`）：每一对左右蛙必须互换一次次序，而唯一能改变次序的动作是跳，
   所以 `ab` 次跳；每只蛙还必须各走一次"进/出空格"的滑步，所以 `a+b` 次滑。两岸齐平时就是 `n(n+2)`。
3. **带记忆的 DFS**（`countOptimalDFS`）：完全不建队列，只问"从这个局面出发最便宜的收尾是多少"。

三条路在 `test/solve.test.mjs`、`tools/bake.mjs` 和浏览器里的 `window.leap.proof()` 各跑一遍。

还有两条更狠的：

* **最优路线只有 2 条**（n=1..6 实测，BFS 分层计数与 DFS 记忆计数各自都给出 2）：开局只有两个合法
  走法（左岸滑或右岸滑），之后每一步都被规则逼死。这两条互为镜像。
  1-vs-b 的不对称河是例外，实测 `2, 3, 5, 8, 13, 21, 34, 55`（斐波那契，`test/make.test.mjs` 钉住）。
* **没有"浪费的一步"**：对 n=1..6 的每一个可达局面检查每一条合法走法，结果只有两种——
  离对岸的距离刚好减 1，或者该局面之后再也到不了对岸（`test/solve.test.mjs` 的 chain theorem 那一行；
  n=6 的空间里 1089 个可达局面、96 个仍可到达对岸、238 处死水）。

每关印的 `par` / `optimalPaths` / `states` 三个数，在构建期由 `tools/bake.mjs` 量出来，
写进 `js/data/lots.js`；同一个脚本紧接着**从序列化之后的行重解一遍**，
复现不上就直接构建失败。CI 里 `node test/library.test.mjs` 再把这件事做一遍。

### 那张表

```
node tools/bake.mjs
```

会打印（数字来自上面那次实测，代码或种子变了就得重跑）：

```
anchors: n=1 par=3 paths=2 states=6 | ... | n=8 par=80 paths=2 states=5093 | n=9 par=99 paths=2 states=10662
generator shipped: 960 lots requested, 1614 proposals, 960 accepted = 59.48% of proposals, 66.77% accepted on the very first try
generator naive : 960 lots requested, 5560 proposals, 960 accepted = 17.27% of proposals, 28.96% accepted on the very first try
wrote 40 lots (shoal:10 linked:10 twined:10 master:10) -> js/data/lots.js
bands shipped: shoal 3-8 | linked 10-24 | twined 28-48 | master 53-80
re-solve gate: 40 serialised rows re-solved and accepted
```

| 带 | 名字 | 实测 `par` | 段数 | 其中两岸齐平 | 其中不对称 | 最大可达局面 |
|---|---|---|---|---|---|---|
| shoal | 浅滩 | 3–8 | 10 | 4 | 5 | 23 |
| linked | 莲塘 | 10–24 | 10 | 4 | 3 | 195 |
| twined | 曲流 | 28–48 | 10 | 3 | 1 | 1089 |
| master | 深渡 | 53–80 | 10 | 4 | 7 | 5093 |

## 怎么跑

零依赖、零打包器、零图片：Node 21+ 就够了（`node --test` 与 CDP 台架都只用内置能力）。

```
npm start                                   # node server.cjs，端口 5196
npm run check                               # 对每个 js/cjs/mjs 跑 node --check
node --test test/                           # 6 个套件；也可以 for f in test/*.test.mjs; do node $f; done
bash tools/verify.sh                        # node 套件 + purity 门 + 真浏览器（headless Chrome + CDP）
SKIP_UNIT=1 bash tools/verify.sh            # 只跑浏览器（CI 的 browser job 就是这么做的）
SCENARIOS="pointer" bash tools/verify.sh    # 只跑真实鼠标那一段
node tools/bake.mjs                         # 重新出题：PER_BAND=24 PROBE=2000 可以让它多出一份
```

线上地址由 `.github/workflows/pages.yml` 做**文件拷贝式**部署：只 `cp index.html css js`。

## 已知边界（不做的事，以及为什么）

* **`steps > par` 这条提示在本玩法里永远不会出现。**规格要求"步数超过 par 时印一句未达下界"；
  实测下来这个分支不可达（见上面第二条）。所以赢的时候只可能刚好 `par` 步，规格那句被换成一条
  真实存在的失败模式：**困水**（这一步合法，但之后再也到不了对岸），面板上 `距对岸` 那一格会
  直接印"困"而不是编一个数字，提示也会承认帮不上忙，只能退回。改动记录在 `deliverable.md` 的
  改动表里。
* **n>8 不发布。**一维串其实还不算大（n=9 是 10662 个可达局面，`tools/bake.mjs` 顺手也算），
  但超过 8 之后"这条河你走得完"就从可读变成不可读，规格 §6 也不允许。
* **点击蛙时没有任何现场搜索。**每条河的距离表在**载入该关**时建一次（`goalTable`），之后
  每次落点只是 `Map.get`。生成/穷举只发生在 bake 期与 `#/random` 换关时，且都有 60 次提案的
  硬上限（`js/core/make.js` 的 `ATTEMPTS`）。实测：一次搜索平均 3.7 ms、最差 85 ms（本机，
  机器忙的时候会更久——这是计时量，不是结构量）。
* 没有成就、排行榜、签到、内购、云存档；分享只分享谜题本身（`#/lot/<id>`、`#/random/<band>/<token>`）。
* 存档只有一个 localStorage key（`leap.save.v1`），读不到就退化成内存会话，面板底部会老实写明
  "本次会话内存"。清档真的把内存和磁盘两边都清掉。

## 目录

```
index.html          内联 SVG data-URI favicon（不新增资产，也不留 /favicon.ico 的 404）
css/game.css        画布盒子的尺寸是有责任的：见 DESIGN.md §4
js/core/rng.js      hashSeed（FNV-1a 派生的两轮 UTF-16 混合）+ mulberry32，与兄弟仓逐字相同
js/core/game.js     规则的唯一实现：状态、合法走法、退回、困水、星星
js/core/solve.js    两路搜索 + 闭式：BFS、倒着走的距离表、带记忆 DFS、ab+a+b
js/core/make.js     出题：在仍可解的水面上游走 k 步，然后把结果交给搜索去量
js/core/library.js  出货关卡的门：从序列化之后的行重解，复现不上就是错误
js/core/storage.js  守卫式存档（js/core 里唯一碰浏览器全局的文件）
js/data/lots.js     tools/bake.mjs 生成的 40 段河，每个数字都是量出来的
js/view.js          只画像素和收手势；不判断合法性
js/main.js          路由、面板、存档、演示，以及 window.leap 测试钩子
tools/bake.mjs      构建期出题 + 四道门
tools/playtest.mjs  零依赖 CDP 驱动（Input.dispatchMouseEvent 真鼠标）
tools/verify.sh     一次性验收门（端口、profile、清理、花括号截 JSON）
test/*.test.mjs     6 个 node 套件
```
