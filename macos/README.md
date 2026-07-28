# Leetcodex for macOS

Leetcodex 把本地算法练习、代码编辑和测试结果放进 Codex 官方输入区。

## 使用

1. 完全退出所有 Codex 窗口。
2. 双击 `Start Leetcodex.command`，或运行 `./leetcodex run`。启动失败时双击脚本会保留窗口和原始退出码，便于读取错误。
3. Codex 打开后按 `Control+Option+L` 进入或退出。

刷题状态中，`Command+Enter` 运行公开样例，`Command+F` 查找代码。`Esc` 关闭查找框或在 Vim 模式下返回 NORMAL；使用 `Control+Option+L` 退出并恢复原 Codex 草稿。

也可以显式指定应用：

```bash
./leetcodex run --codex-path /Applications/ChatGPT.app
```

启动脚本也会转发参数，例如 `./Start\ Leetcodex.command --port 9444`。

## Codex++

```bash
./leetcodex install-codex-plus-plus
./leetcodex uninstall-codex-plus-plus
```

默认脚本位置是 `~/.config/Codex++/user_scripts/leetcodex.js`。
两个命令都只会操作带有 Leetcodex 标记的脚本，不会覆盖或删除同名的其他文件。

## 诊断与草稿

运行 `./leetcodex doctor` 可检查 Codex、账号配对浏览器、CDP 端口、renderer 注入版本与实例健康度以及草稿目录；`./leetcodex doctor --json` 可生成带顶层 `healthy` 和结构化 `drafts` 状态的诊断结果。Launcher 检查会拒绝链接的 runtime 目录或锁文件，并将畸形锁报告为 `invalid_metadata`、旧版锁报告为 `version_mismatch`；草稿检查只读验证真实目录、可读性和 Unix 隐私权限。`./leetcodex doctor --strict --json` 会在完整运行栈不健康时返回非零退出码。Renderer 检查只暴露 Bridge 队列数量和时间统计，卡住的请求报告为 `bridge_stalled`；它不会读取请求、对话或草稿内容，LeetCode 是否已登录不影响健康结论。

草稿除了保存在 Codex 内，还会备份到 `~/.leetcodex/drafts/v1/`。Codex 本地缓存被清理后，Leetcodex 会自动恢复对应站点、题目和语言的源码。原生读写会逐级验证受控目录并拒绝父级符号链接，防止草稿路径被重定向。

账号浏览器配置需要修复时，先完全关闭对应浏览器，再运行 `./leetcodex reset-pairing --site global --yes`，中国站使用 `china`。旧配置会保留在 `~/.leetcodex/pairing-backups/`。配置、备份及共享父目录中的符号链接会在 Cookie 数据移动前被拒绝。

使用 `./leetcodex list-pairing-backups --site global` 查看备份，再通过 `./leetcodex restore-pairing --site global --backup <name> --yes` 恢复。恢复不会覆盖已有配置。

## 系统安全提示

自动构建产物没有 Apple Developer ID 签名和公证。正式分发前应配置签名与公证。
