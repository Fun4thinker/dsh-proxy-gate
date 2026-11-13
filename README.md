# dsh-proxy-gate —— 给 AI 的代理开关

一款 DeepSeek Harness 插件：**把梯子订阅搬到 DSH 上，并按需开/关一个本地代理出口**，让 AI 在需要境外网络时自己把路打通，而不是卡在超时里。

安装后 AI 拿到 4 个工具（`proxy` / `proxy_nodes` / `proxy_subscription` / `proxy_fetch`），系统提示里也会多一段「什么时候该开代理」的策略说明与实时状态。你只需要说「这个包从 GitHub 装一下」，剩下的它自己会做。

| 工具 | 参数 | 作用 |
|---|---|---|
| `proxy` | `action: status \| on \| off`、`node?`、`upstream?`、`verify?`、`showNodes?` | 开关代理 + 看状态 + 切节点 |
| `proxy_nodes` | `action: list \| test`、`filter?`、`limit?` | 列节点、全量测速并排序 |
| `proxy_subscription` | `action: list \| import \| use \| refresh \| remove` | 订阅搬家与维护 |
| `proxy_fetch` | `url`、`maxChars?`、`timeoutMs?`、`userAgent?` | 一定走代理的文本抓取 |

为什么是 4 个而不是更多：工具 schema 是每轮 prompt 的固定开销。原先 `proxy_status` / `proxy_on` / `proxy_off` 三个工具参数高度重叠，合并成 `proxy` + `action` 省下两份 schema；切节点本来就能用 `proxy(action="on", node=...)`，所以 `proxy_nodes` 不再提供 `use`。

## 胶囊灯点语义

| 灯 | 含义 |
|---|---|
| 灰色常亮 | 手动管理 + 代理关闭 |
| 绿色常亮 | 手动管理 + 代理开启 |
| 绿色呼吸 | 自动管理（AI 可自主开关）+ 代理开启 |
| 蓝色常亮 | 自动管理 + 代理关闭 |
| 警示色 | 代理开着但一个可用节点都没有 |

胶囊上还直接写「自动 / 手动」文字，不只靠颜色区分。

## 团队共享：引用计数

代理是**进程级资源**，不按智能体隔离。如果只用一个全局开关，子智能体执行完 `off` 就会把主智能体正在用的代理一起关掉——这在协作里几乎必然发生。所以按**引用计数**管理：

- 谁开代理，就为它登记一份持有（同一个持有者重复 `on` 不会重复计数）；
- 谁关代理，只释放自己那一份；**计数归零才真正停内核**；
- 智能体被销毁时，它持有的引用**自动释放**（`agent/disposed`），避免泄漏；
- 面板上的「关闭」是**强制**关闭（释放全部），因为那是人的明确意图。

实测（两个持有者）：

```
holderCount=2   ← 主会话 + 另一个持有者
释放其中一个    → holderCount=1，代理保持开启，端口仍在监听
释放最后一个    → holderCount=0，内核停止，环境变量还原
```

`proxy(action="status")` 会显示当前持有者；面板里也会列出「谁在用」。

---

## 自动故障转移与健康守护

这两件事对应「别让任务卡死」：

**自动故障转移**（`autoFailover`，默认开）

- `proxy(action="on")` 后如果连通性验证失败，会**自动换节点**：候选按已测速的延迟升序，最多试 `failoverMaxTries`（默认 3）个，每个都做真实请求验证，成功才留下；
- `proxy_fetch` 请求失败时同样会先换节点再**重试一次**，而不是把错误直接丢回去；
- 实测：指定一个死节点开启 → 自动切到可用节点 → YouTube 200。

**健康守护**

- 内核意外退出（崩溃/被系统或安全软件结束）时，只要还有持有者，就**自动重启一次**；
- 5 分钟内最多重启 3 次，避免崩溃循环；
- 实测：强杀 mihomo 进程 → 6 秒内自动拉起 → 端口恢复 → 出境恢复 200；意外退出原因会记在 `lastError` 里。

## 管理入口

输入框工具行左侧有一个小胶囊「● 代理」（`conversation.input.left`），点开是一个居中弹窗面板。

为什么是弹窗而不是一条横幅：输入框宽度可以鼠标拖动调整，普通横幅没法稳定对齐；弹窗自己定宽，既不用同步宽度，也不占用 `conversation.input.dock` 那一行，**任务清单等既有条目完全不受影响**。

弹窗里分四块：

- **模式**：`AI 自主开关` 开/关
- **订阅**：多订阅列表（标出生效项）+ `[使用]` / `[移除]`；粘贴订阅链接 `[导入]`；`[从 Clash Verge 导入]`
- **节点**：`可用 N / 共 M`、逐个延迟徽标 + `[使用]`，占位节点单独提示
- **借用本机代理客户端**：自动识别候选端口一键借用，或手填端口

界面与 AI 工具共用同一份 Host 实现（面板走 `/proxy-gate-api/*`，工具走 `ctx.tools`），两边状态与失败原因永远一致。

面板接口只响应同源请求且要求自定义请求头 `x-proxy-gate: 1`：跨站请求会先触发 preflight，而本路由不响应 OPTIONS，因此外部网页无法用 CSRF 的方式切你的代理。

## 两种工作模式（自动 / 手动）

面板上那个 `AI 自主开关` 就是总闸：

| | 自动模式（默认） | 手动模式 |
|---|---|---|
| AI 能看到代理工具 | ✅ 6 个工具常驻 | ❌ **一个都不注册** |
| AI 自己开/关代理 | ✅ 遇到境外任务自动开、收尾自动关 | ❌ 由你在面板上开/关 |
| 系统提示 | 使用指引 + 一行实时状态 | 只有实时状态 |
| 适用 | 让 AI 自己搞定境外依赖 | 你完全掌控出口，AI 只是"恰好"走代理 |

**为什么这样设计（关于缓存）**：工具 schema 和系统提示都是 prompt 前缀的一部分，增删工具会让整段前缀失效。所以：

- 自动模式下工具集**恒定**，不会随每轮、每次开关代理而变——开关代理只改环境变量，不动工具集；
- 切换模式才会改变一次工具集（一次缓存失效），这是你显式操作的，可预期；
- 那行实时状态只在「开关代理/切节点」时改文本，同样最多一次失效，不会逐步抖动。

所以你在会话里看到「加载工具 / 移除工具」，要么是切换了模式，要么是插件被重载；正常使用时不会出现。

## 新设备上怎么开始用

装完插件、界面出现「代理网关」栏之后，按你有哪种梯子选一条：

| 你的情况 | 怎么做 |
|---|---|
| 有机场订阅链接 | 展开面板 → 粘贴链接 → `[导入]`（自动下载快照并设为生效订阅） |
| 装了 Clash Verge | 展开面板 → `[从 Clash Verge 导入]`（复用它当前选中的订阅，插件首次加载时也会自动试一次） |
| 只有官方客户端（跨界云等），且它已在运行 | 展开面板 →「借用本机代理客户端」里会列出探测到的端口 → 点一下 `借用`；或手填它的 HTTP 代理端口 |
| 什么都没有 | 先装 Clash Verge（插件会直接复用它的 `verge-mihomo.exe` 内核），或有任意 mihomo 二进制放进 PATH |

订阅为空时，面板和 `proxy_on` 都会直接告诉你缺什么、下一步做什么，不会只丢一句"失败"。

## 三种接入方式

### A. 复用本机 Clash Verge 的订阅（零配置）

本机装了 Clash Verge（含 rev）时，插件**首次加载就自动**把它当前选中的订阅搬进 DSH：

```
$DSH_HOME/proxy-gate/subscriptions/<id>.yaml
```

这是**快照**——之后就算 Clash Verge 关掉、甚至卸载，代理照样能用。想搬别的配置或刷新时：

```text
proxy_subscription(action="list")                                   # 看有哪些可搬
proxy_subscription(action="import", source="clash-verge", value="uid")
proxy_subscription(action="refresh")                                # 从订阅地址重新拉
proxy_subscription(action="use",    value="订阅 id")                 # 切换生效项
proxy_subscription(action="remove", value="订阅 id")                 # 删除（连同本地快照）
```

> 注意：Clash Verge 本地快照可能是很久以前的（甚至已过期变成占位节点），而它的订阅地址仍是活的。这时 `refresh` 往往会拉到一批新节点，值得先试一次。

### B. 直接导入订阅地址或本地文件

```text
proxy_subscription(action="import", source="url",  value="https://机场?...", name="我的机场")
proxy_subscription(action="import", source="path", value="D:\\backup\\clash.yaml")
proxy_subscription(action="use",    value="我的机场")
```

### C. 借用官方客户端的本地端口（没有 Clash 订阅时）

跨界云这类**只给官方客户端、不给 Clash 订阅**的梯子，用「借用模式」：插件不启动内核，只把 AI 的出口指向那个客户端已经开好的本地代理口。

```text
proxy_on(upstream="7897")            # 或 127.0.0.1:7897 / http://127.0.0.1:7897
```

也可以在 patch 里长期配置：

```yaml
- id: proxy-gate
  name: dsh-proxy-gate
  config:
    upstreamProxy: '7897'
```

此模式下 `proxy_on()` 直接生效，节点由那个客户端管理（插件不参与切节点）。

---

## AI 侧怎么生效

`proxy_on()` 做三件事：

1. 用本机内核（Clash Verge 自带的 `verge-mihomo.exe`，或 PATH 里的 mihomo/clash-meta）拉起一个只监听 `127.0.0.1:7892` 的 mixed 端口（HTTP + SOCKS 同端口）；
2. 把订阅快照里切出来的 `proxies` 段交给内核的 `file` 型 proxy-provider —— **解析全部交给内核**，插件不实现任何协议；
3. 向宿主进程写入 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，于是后续 spawn 出来的 `pwsh` 里，**curl / git / npm / pip / python requests 自动走代理**，不需要模型自己加 `-x`。

另外提供 `proxy_fetch(url)`：一定走代理的文本抓取，用来兜住内置 `web_fetch` 的短板（见下）。

收尾 `proxy_off()` 停内核并**还原**环境变量，不会长期污染宿主环境。

## 覆盖范围

| 目标 | 走插件代理？ | 原因 |
|---|---|---|
| pwsh 里的 `curl`/`git`/`npm`/`pip` | ✅ 实测 YouTube 200 | 子进程继承 `HTTP_PROXY` |
| `proxy_fetch` 工具 | ✅ | 强制带 `-x` |
| **DSH 内置浏览器（侧边栏）** | ✅ 按实测有效 | 它跑在 DSH 自己的进程链路里，沿用宿主出口 |
| 内置 `web_fetch` / `web_search` | ❌ | 用 app.asar 里的 undici 实例，自带 dispatcher，插件改不了 |
| 外部浏览器（Edge / Chrome） | ❌ | 独立进程，不读 DSH 的环境变量 |
| 其他应用 / 系统流量 | ❌ | 不做 TUN、不接管系统流量 |

## 必须知道的限制

- **内置 `web_fetch` / `web_search` 不走本代理**。它们用的是宿主进程 app.asar 里的 undici，插件无法给那份实例装代理 dispatcher（插件自己再装一份 undici 是另一个实例，设置无效）。境外页面抓不动时用 `proxy_fetch`，或在 pwsh 里 curl。
- **DSH 内置浏览器会走这个出口**（实测），所以开代理时侧边浏览器能打开境外站点；但外部浏览器（Edge/Chrome）不会，它们是独立进程。
- **环境变量只对「之后新起的子进程」生效**。`proxy_on` 改的是宿主进程的 env，已经跑起来的 shell 不会回溯更新；新起的每一次 `pwsh` 工具调用都能继承（实测：新进程里裸 `curl` 直接 200 / 204）。
- **重载/重启插件会停掉正在运行的内核**。卸载时插件会主动 `stop()` 它自己拉起的内核（避免留野进程），所以重载后需要重新 `proxy_on`。重载期间如果看到状态前后不一致，就是这个原因。
- **健康检查通过 ≠ 真实站点可用**。机场节点对 `generate_204` 这类探测端点常常是通的，但对真实站点可能握手失败（实测台湾某节点：探活 80ms，访问 YouTube 却 TLS 重置）。所以 `proxy_on` 之后一定会再做一次真实连通性验证，不要只看节点延迟。
- 插件**不碰系统代理、不碰 TUN**，也不会去动你正在用的 Clash Verge 本体（端口默认 7892，避开它的 7897）。这是刻意的：**AI 单独走代理，人继续用内网**。
- 内核的最小运行配置只含 `MATCH,PROXY` 一条规则，**故意不继承订阅里的 dns / rules**：订阅的 `dns.fallback-filter.geoip` 会触发 MMDB 下载，冷启动会阻塞约 90 秒且可能直接 fatal。

## 测速与节点管理

mihomo 的 `/proxies/{name}/delay` **不接受非 ASCII 节点名**（机场节点几乎都带 emoji/中文，请求会 404 `Resource not found`）。所以测速走的是另一条路：

1. `POST /providers/proxies/sub/healthcheck` 触发整组健康检查（内核内部并发，55 个节点约 12–15 秒）；
2. `GET /providers/proxies/sub` 一次读回每个节点的 `alive` 与 `history[].delay`。

实测：云鸟 55 个节点里 20–29 个可用，最快约 39–80ms。占位节点会被精确判死，不会再被误选。

AI 用 `proxy_nodes(action="test")`，人用面板上的「测速」按钮——两者是同一份实现。


## 排错

| 现象 | 原因与处理 |
| --- | --- |
| `proxy_on` 说找不到内核 | 装 Clash Verge（直接复用它的内核），或在 patch 里设 `corePath` 指向 mihomo/clash-meta 可执行文件 |
| 端口被占用 | Clash Verge 默认 7897；改 patch 里的 `port` |
| 开了代理但全部不通，且提示「占位节点」 | 机场超量/到期会下发假节点（名字像「您流量用完了」「剩余流量：100 GB」，ss 指向 `1.1.1.1:443`）。重置/续费后 `proxy_subscription(action="refresh")` |
| 想确认是节点还是隧道的问题 | `proxy_on(node="DIRECT")` —— 走直连，能通则说明本地隧道正常、问题在节点 |
| 站点返回 403 | 先别怀疑代理：GitHub API 限流也是 403。`proxy_status(verify=true)` 里「链路通、被站点拒绝」就是隧道正常 |
| 刚开启瞬间看不到节点 | 已处理：内核的 provider 是异步加载的，插件会等到节点就绪再回报 |

## 配置项（profile patch 覆盖）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `port` | `7892` | 本地 mixed 代理端口 |
| `controllerPort` | `7893` | mihomo 控制口（仅 127.0.0.1） |
| `corePath` | `''` | 内核路径，留空自动探测 |
| `autoStart` | `false` | 加载即拉起代理 |
| `upstreamProxy` | `''` | 借用外部客户端端口（B 模式） |
| `upstreamPorts` | `[7897, 7890, 10808, 10809, 1080]` | 自动探测的候选端口 |
| `noProxy` | `localhost,127.0.0.1,::1,.local` | 不走代理的地址 |
| `testUrls` | gstatic 204 + github zen | 验证用 URL |
| `promptGuidance` | `true` | 是否注入使用策略 |

## 数据落在哪

```
$DSH_HOME/proxy-gate/
├── subscriptions.json          # 订阅清单
├── state.json                  # 当前订阅、上次节点
├── subscriptions/<id>.yaml     # 订阅快照（搬家后的真身）
└── runtime/                    # 每次启动重写
    ├── config.yaml             # 生成的最小运行配置
    ├── provider.yaml           # 从快照切出来的 proxies 段
    ├── core.log               # 内核日志（排错看这里）
    └── core.pid
```

## 无依赖

零外部依赖：只用 Node 内置模块 + Windows 自带的 `curl.exe` + 复用本机已有的 mihomo 内核。之所以不用 `@deepseek-ai/*` 或 `js-yaml`：profile 的 node_modules 里没有它们，链接式安装的插件解析不到，任何一条依赖都会让插件在别的 profile 里装不上。
