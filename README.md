# dsh-music-tui

在 dsh-TUI 里查看并控制已经运行的 YesPlayMusic TUI。插件提供 `/music`
命令和提示框上方的紧凑音乐条，不修改 DeepSeek Harness、dsh-TUI 或
YesPlayMusic 本体，也不会自动启动播放器。

## 能做什么

- `/music` 或 `/music show`：打开音乐条（默认隐藏）
- `/music hide`：关闭音乐条
- `/music status`：一次性显示曲名、歌手、专辑与进度详情
- `/music toggle`：发送播放/暂停切换
- `/music next`：发送下一首
- `/music prev`：发送上一首
- `/music seek <秒>`：跳到歌曲的绝对时间，例如 `/music seek 90.5`
- 音乐条显示小封面、曲名、歌手、进度、实时频谱和上一首/播放暂停/下一首/关闭按钮

fullscreen 模式下，鼠标按钮与 slash 命令等价，进度条支持点击定位和拖动预览；
松手时只发送一次 seek。inline 模式请使用 `/music seek <秒>`。控制正在等待时会
暂时禁用重复操作，切歌或暂停不会擅自
打开、关闭音乐条。富状态视图可用时最多占三行，并随终端宽度降级：窄屏优先
保留三个控制和关闭按钮。旧版宿主没有常驻状态行，`/music` 会返回一次性详情。
按钮图标跟随 YPM 的 `icons = "unicode" | "nerd"` 设置；旧 YPM 没有上报该字段时安全回退
到 Unicode。
宿主支持 Kitty graphics 时封面会显示为平滑真图；其他终端、inline、辅助功能模式
或终端多路复用器会自动使用同尺寸的半块字符缩略图，不需要额外配置。
终端达到 80 列时，音乐条右侧才订阅真实音频频谱；80/96/120 列分别使用
12/18/24 格，超过 120 列后每增加 2 列再增加 1 格，最多 48 格。窄屏会释放本插件的频谱订阅；若 YPM 自身没有显示频谱，分析器也随之停用。内置 `blocks`、`led`、
`braille`、`shade` 四种紧凑样式，也可以跟随 YPM 当前支持的同名样式。

控制结果只会说“已发送”。YesPlayMusic 的 CLI 确认的是命令已接收，而不是播放器
已经完成切歌；插件随后会重新读取状态，绝不把确认包冒充最终播放状态。

## 前置条件

- Node.js `^22.19 || >=24`
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) `>=0.9.2 <0.11.0`
- [YesPlayMusic TUI](https://github.com/nagi-studio/YesPlayMusic) 及其 `ypm` CLI
  （当前验证版本：`ypm 0.11.0`；实时频谱需要此版本）
- macOS 或 Linux；`ypm` 的 TUI 远程控制面使用本机 Unix socket

先确认 `ypm` 在 `PATH` 中：

```sh
ypm --version
```

## 安装

当前 npm 包尚未发布。从仓库安装：

```sh
git clone https://github.com/Nagi-ovo/dsh-music-tui.git
cd dsh-music-tui
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile dsh-tui add "$PWD"
```

发布到 npm 后，可以直接使用包名：

```sh
dsh plugin --profile dsh-tui add @dsh-tui-ecosystem/music
```

先在另一个终端或后台启动 YesPlayMusic TUI，再启动 DSH：

```sh
dsh --profile dsh-tui
```

不需要改 YesPlayMusic 源码，也不需要在 YesPlayMusic 仓库里安装插件。
本插件不会替你启动或关闭 YesPlayMusic。

## 配置

默认配置已经写进 `cordis.patch.yml`：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `executable` | `ypm` | CLI 名称或绝对路径 |
| `showStatus` | `true` | 是否启用可由 `/music` 打开的音乐条；启动时仍保持隐藏 |
| `pollIntervalMs` | `3000` | 在线轮询间隔（1000–60000 ms） |
| `timeoutMs` | `3000` | 单次 CLI 硬超时（250–30000 ms） |
| `spectrumStyle` | `follow` | `off` / `follow` / `blocks` / `led` / `braille` / `shade` |

`showStatus: false` 不会注册音乐条；此时 `/music` 与 `/music show` 退化为一次性
详情，status 与播放控制仍可用。宿主没有富视图能力，或富视图因键冲突/行预算
被拒绝时也采用相同降级，不启动后台轮询。

要覆盖配置，在 profile 自己的 `cordis.patch.yml` 里按同一行 id 写完整配置：

```yaml
- id: dsh-music-tui
  config:
    executable: /absolute/path/to/ypm
    showStatus: true
    pollIntervalMs: 3000
    timeoutMs: 3000
    spectrumStyle: follow
```

## 设计边界

```text
dsh-TUI /music + status
          │
          ▼
  @dsh-tui-ecosystem/music
          │ execFile / spawn(argv), no shell
          ▼
       ypm --json --tui …
          │
          ▼
  running YesPlayMusic TUI
```

- 插件只调用公开 `ypm` CLI，不直连私有 Unix Socket。
- 目标固定为 TUI；不会在 GUI 与 TUI 之间猜测。
- 播放状态不写入 DSH 会话日志。只有 DSH 命令注册表正常产生的
  `command/run` / `command/done` 记录。
- 外部 JSON、stderr 和歌曲元数据全部校验、去终端控制字符并限制长度。
- 音乐条注册成功后默认每 3 秒读取一次状态；播放时每秒在本地推进显示进度，
  暂停时冻结。一次读取失败保留旧状态，连续两次失败才清除；离线后轮询退避。
- 频谱只在音乐条可见、存在歌曲且终端至少 80 列时，通过公开的
  `ypm --json --tui spectrum --fps 12` NDJSON 流订阅。协议固定为 32 个 0–255 bins；
  不读取 PCM、不直连 socket，断流会清掉旧画面并有界退避重连，隐藏、变窄或卸载会中止子进程。
- `follow` 只跟随 YPM 的 `blocks`、`led`、`braille`、`shade`；遇到其他样式安全回退为
  `blocks`。重复帧不会触发无意义的 TUI 重绘。
- 新版 `ypm` 通过 `seekable` 显式宣告 seek 能力，并用 `iconStyle` 投影用户已选的图标模式。
  旧版未上报时，进度仍可读、但不会伪装成可拖动，图标回退到 Unicode。
- 新版 `ypm` 可选返回 `coverUrl`。插件只下载 HTTPS `music.126.net` 及其子域的
  JPEG/PNG（按文件魔数识别，兼容 CDN 错标响应头），每次重定向都重新校验，
  并限制为 2 秒、256 KiB 与 1024×1024 像素；失败只显示占位封面。
- 封面只在 URL 变化时读取，内存最多缓存 16 张。旧版 `ypm` 没有 `coverUrl`
  时文本与控制照常工作。
- 图片由插件解码成 96×96 RGBA，并同时生成 6×3 字符回退；Kitty 协议探测、上传、
  定位与清理由宿主统一负责，插件不会直接向终端写转义序列。
- 卸载时清理 timer、命令、音乐条、封面请求并中止子进程。
- 音乐条以能力探测接入富状态视图，不提高 `dsh-TUI ^0.9.2` 的最低兼容版本；
  没有富视图 API 时只保留 `/music` 的一次性详情和播放控制，不创建常驻状态，
  也不轮询。
- 当前 DSH profile loader 仍用 Cordis bundle 挂载第三方插件；命令在没有
  verified Component identity 时走规范记录的 C-070 同进程兼容路径。
  `dsh-plugin.json` 的 host entry 是独立的标准 FacetModule；adapter-dsh 存在时，
  它会先接管 `/music`，旧 Cordis 注册随即让位，避免双注册。两条路径共用同一
  命令实现与已配置的 controller。

当前信任模型是 `trusted-in-process`：manifest 权限用于兼容性、授权和审计，
不是进程隔离或安全沙箱。

## 本地开发与验证

```sh
pnpm install --frozen-lockfile
pnpm verify
```

本地装进 profile：

```sh
dsh plugin --profile dsh-tui add "$PWD"
```

然后分别验证：`/music` 的 show/hide/status/toggle/next/prev/seek、fullscreen 点击与拖动进度、
32/60/80/96/120 列布局和四种频谱样式，以及旧宿主降级、播放器离线、`ypm` 不在 PATH
和插件卸载。

## 许可证

MIT
