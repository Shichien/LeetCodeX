# Leetcodex

Leetcodex 是一个直接在 Codex 桌面版官方输入区内运行的编程练习工具。它组合了 LeetCode 刷题与 CotypeX 代码打字两种互斥模式。刷题模式可以选择 `leetcode.com` 或 `leetcode.cn`，配对对应站点的账号，按标题或题号搜索官方题库、按难度和算法类型筛选、切换语言模板、运行样例、提交到官方 judge 并同步 Accepted 状态。未登录时仍可使用内置离线题库。Typing 模式提供 2,160 条多语言业务代码片段、计时与字数预设、准确率和 WPM 统计、收藏、每日练习及输入辅助设置。

官方题面会保留段落和列表换行，并以 Markdown 风格反引号标记行内代码；长文本和长标识符会在题面区域内自动换行。

账号登录通过独立 Chrome、Edge 或 Chromium 配置完成。密码和 Cookie 留在浏览器中，Leetcodex 通过页面的同源请求访问两站各自的 GraphQL、提交和判题接口，不要求用户粘贴会话 Cookie。每个站点的专用配置使用 Chromium 动态分配的回环调试端口，并在复用前校验配置拥有的端点身份，避免与用户的其他调试浏览器冲突。

## 使用

### macOS

先完全退出 Codex，再运行：

```bash
./target/release/leetcodex run
```

如果自动发现失败，可通过 `--codex-path /Applications/Codex.app` 显式指定应用。

Codex 打开后按 `Control+Option+L` 进入或退出刷题模式，按 `Control+Option+T` 进入或退出 Typing 模式。两个模式的工具栏也可以直接互相切换。

在面板中选择站点并点击 `Login`。完成浏览器登录后，账号名、官方题库和提交功能会自动出现。全球站与中国站使用不同的浏览器配置，可以分别保持登录。

### Windows

```powershell
.\leetcodex.exe run
```

Codex 打开后按 `Ctrl+Alt+L` 进入或退出刷题模式，按 `Ctrl+Alt+T` 进入或退出 Typing 模式。两个模式的工具栏也可以直接互相切换。

发布包也提供 `Start Leetcodex.cmd`，可以直接双击启动。自动发现失败时，使用 `--codex-path "C:\绝对路径\ChatGPT.exe"`。

### 已有调试端口

如果 Codex 已通过可信启动器开放 `9337`：

```bash
./target/release/leetcodex attach --port 9337
```

同一个 CDP 端口只允许一个 Leetcodex 启动器。重复双击或重复运行会保留现有会话并立即给出明确错误，避免多个 Bridge 注入互相覆盖。不同端口可以运行独立实例。启动锁保存在 `~/.leetcodex/runtime/`，读写不会跟随符号链接或 Windows reparse point；检测到被重定向的 runtime 路径或锁文件时会拒绝启动。

### 一键诊断

`doctor` 只读取本机环境，不会启动或修改 Codex：

```bash
./target/release/leetcodex doctor
./target/release/leetcodex doctor --json
./target/release/leetcodex doctor --strict --json
```

报告会包含顶层 `healthy`、Leetcodex 版本、操作系统、Codex 安装位置、账号配对浏览器、两站独立配对会话的配置目录与动态端口、启动器单实例锁、Codex CDP 状态、只读 renderer 注入健康度和结构化 `drafts` 草稿目录状态。Launcher 诊断会拒绝链接或重解析的 runtime 目录和锁文件，并从已验证句柄读取最多 4 KiB 的锁元数据；只有 PID、端口和版本结构完整且与本次诊断一致时状态才是 `active`，畸形或端口错误为 `invalid_metadata`，旧版 launcher 为 `version_mismatch`。草稿诊断只读取路径类型、可读性和 Unix 隐私权限，不创建或修改文件；Renderer 诊断会验证 Leetcodex 与 CotypeX 的版本和实例数量，并以 `mode: "leetcode"`、`mode: "typing"` 或 `mode: null` 表示当前模式。它还读取 Bridge 队列长度、最老请求年龄和过期数量，但不读取请求内容、对话、练习文本或草稿内容。超过截止时间与两秒调度宽限的请求会报告 `bridge_stalled`。`--strict` 会在 Codex、账号浏览器、launcher、CDP、renderer 或草稿目录不安全/不可用时返回非零退出码；LeetCode 是否已登录不影响健康结论。旧版 `draftDirectory` 路径字段继续保留。提交问题时建议附上 `--json` 输出，但不要附带草稿文件内容。

### 重置账号配对

专用浏览器配置损坏或需要彻底切换账号时，先关闭对应的 Chrome/Edge 窗口，再运行：

```bash
./target/release/leetcodex reset-pairing --site global --yes
./target/release/leetcodex reset-pairing --site china --yes
```

命令只处理指定站点，并把原配置移动到 `~/.leetcodex/pairing-backups/`。浏览器仍连接或存在活动 Chromium 单实例标记时会拒绝执行。配置、备份及其共享的 `.leetcodex` 父目录必须是非符号链接、非 Windows reparse point 的真实目录，否则 reset 会在移动 Cookie 数据前失败。

查看和恢复备份：

```bash
./target/release/leetcodex list-pairing-backups --site global
./target/release/leetcodex restore-pairing --site global --backup global-profile-<timestamp>-<pid> --yes
```

恢复命令不会覆盖已有配置。备份名称必须属于所选站点且符合 Leetcodex 生成格式，符号链接、Windows reparse point、带活动 Chromium 标记的目录以及不与目标 profile 共享受控父目录的备份都会被拒绝。

## 操作

- `Ctrl+Alt+L`：进入或退出 Leetcodex，并恢复原 Codex 草稿。
- `Ctrl+Alt+T`：进入或退出 CotypeX Typing 模式，并恢复原 Codex 草稿。
- 面板中的 `Typing` / `LeetCode`：不退出练习区，直接在两种模式之间切换。
- `Ctrl+Enter` 或 `Command+Enter`：运行公开样例。
- `Ctrl+F` 或 `Command+F`：打开编辑器右上角查找与替换。
- `Ctrl+S` 或 `Command+S`：立即保存当前草稿。
- `Esc`：关闭查找框；Vim 模式下返回 NORMAL，不会退出 Leetcodex。
- `Run`：在线题调用 LeetCode 官方运行接口；离线 JavaScript 题在隔离 Worker 中执行。
- `Submit`：在线题提交到官方 judge；离线 JavaScript 题运行全部本地测试。

面板中的 Vim 开关会持久保存。题目、站点和语言分别使用独立草稿，切换或关闭页面不会丢失代码。启动器还会把草稿原子备份到 `~/.leetcodex/drafts/v1/`；中断的文件替换会在下次访问时自动恢复，Codex WebView 本地数据被清理后也会从这份原生备份恢复。原生草稿读写会逐级验证受控目录，在任何父级为符号链接或 Windows reparse point 时拒绝操作，避免备份路径被重定向到用户目录之外。

Codex 在任务切换或页面更新时如果重建官方输入区，Leetcodex 会先保存当前代码，再自动挂载到新的输入区并恢复编辑器状态；短暂找不到 composer 时会继续等待，而不会退出练习模式。

## Codex++

可直接加载 `dist/leetcodex.user.js`，也可以运行：

```bash
./target/release/leetcodex install-codex-plus-plus
```

默认安装文件是 `~/.config/Codex++/user_scripts/leetcodex.js`。

Windows 默认位置是 `%APPDATA%\Codex++\user_scripts\leetcodex.js`。

卸载持久脚本：

```bash
./target/release/leetcodex uninstall-codex-plus-plus
```

安装和卸载只会替换或删除带有 Leetcodex 标记的 `leetcodex.js`。如果目标位置已有同名的其他脚本，命令会拒绝操作并保留原文件。

## 构建

```bash
cd web
pnpm install --frozen-lockfile
pnpm test
pnpm build
cd ..
cargo fmt --check
cargo test --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
cargo build --release --locked
```

产物：

- `target/release/leetcodex`
- `dist/leetcodex.user.js`

### 发布包

macOS universal 包必须在 macOS 构建：

```bash
bash scripts/build-macos-release.sh
```

Windows x64 包必须在 Windows PowerShell 构建：

```powershell
.\scripts\build-windows-release.ps1
```

安装 Homebrew `mingw-w64` 后，也可以在 macOS 生成用于交叉验证的 Windows GNU x64 包：

```bash
bash scripts/build-windows-cross-release.sh
```

GNU 包会单独标记为 `windows-x64-gnu`，不会替代 GitHub Release 中由 Windows runner 构建和验证的 MSVC 正式包。

两个脚本都会运行完整测试并生成 zip、zip 对应的 `.sha256`、独立启动脚本和包内 `SHA256SUMS.txt`。Git tag `v*` 会触发 macOS 与 Windows 构建，为两个 zip 生成 GitHub build-provenance attestation，并发布 GitHub Release。

发布包同时包含 `THIRD_PARTY_NOTICES.md`，列出锁定的 Rust 与前端生产依赖、许可证、作者、来源和包内实际许可文本。依赖变化后运行 `node scripts/generate-third-party-notices.mjs`，CI 会拒绝过期清单。

安全漏洞请按照 [SECURITY.md](SECURITY.md) 通过 GitHub Security Advisory 私密报告。CI 会阻止存在高危 npm 生产依赖公告或 RustSec 告警的版本进入发布流程。

发布 tag 必须与 `Cargo.toml` 版本完全一致，例如版本 `0.2.0` 只能使用 `v0.2.0`。CI 还会要求 [CHANGELOG.md](CHANGELOG.md) 存在对应日期的版本条目，避免同一版本号发布不同内容。

## 故障诊断

- 提示端口被占用：完全退出所有 Codex 进程，或通过 `--port` 选择其他端口。
- 提示 `Login required`：点击当前站点的 `Login`，在打开的专用 Chrome/Edge 配置中完成登录并保留该窗口。
- 官方题库加载失败：确认所选站点与登录站点一致；`leetcode.com` 和 `leetcode.cn` 使用独立会话。
- Windows 自动发现失败：使用 `--codex-path` 指定 Codex 可执行文件的绝对路径。
- macOS 阻止未签名二进制：先核对 `SHA256SUMS.txt`；正式公开分发仍应配置 Developer ID 签名和公证。

## 安全边界

- 只连接指定的本机回环 CDP 端口。
- 只注入 Codex 主渲染页面，排除头像覆盖页。
- 不修改 Codex 应用包、`app.asar` 或系统配置。
- 不读取对话内容；只在激活时暂存并恢复官方输入框草稿。
- 离线题库、测试和 solved 状态保存在本机；在线提交直接发送到用户选择的官方站点。
- 草稿同时保存在 Codex WebView 和用户目录下的 `~/.leetcodex/drafts/v1/`，备份文件为仅包含源码的纯文本；原生读写拒绝受控路径中的符号链接和 Windows reparse point。
- 启动器锁写入 `~/.leetcodex/runtime/`，目录链和锁文件必须是非符号链接、非 Windows reparse point 的真实对象；锁元数据读写均通过经过验证的文件句柄完成。
- 账号桥使用 Codex 的本地 CDP 绑定，并要求每次启动随机生成的 256 位令牌；不会开放额外 HTTP 端口。
- 全球站和中国站使用独立配置目录，并由 Chromium 分别分配动态回环调试端口。
- Unix 系统上的专用账号配置目录限制为当前用户访问；登录、诊断、reset 和 restore 会逐级拒绝配置或备份路径中的符号链接及 Windows reparse point。
- 用户代码在独立 Worker 中执行，并设置 2 秒超时。

## 项目边界

Leetcodex 是第三方本地工具，不隶属于 OpenAI 或 LeetCode。在线能力依赖两站当前公开页面接口；接口变化会由 CI 和后续兼容版本处理。发布前仍需在真实账号与 Windows 真机上完成冒烟验证。

## 项目结构

```text
src/                       Rust 启动器和 CDP 客户端
web/src/problems.json      本地题库与测试
web/src/runner.js          隔离代码执行器
web/src/index.js           Codex 注入与交互
web/src/styles.css         输入区界面
web/tests/                 题库和判题逻辑测试
dist/leetcodex.user.js     共享用户脚本
```
