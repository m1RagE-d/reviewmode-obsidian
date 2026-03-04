# Critic Track

Obsidian 插件：基于 CriticMarkup 语法的轻量级修订追踪。

## 功能

- **修订模式开关**：侧边栏图标 / Command Palette / 快捷键一键切换
- **自动标记**：修订模式下，删除、替换、新增操作自动生成 CriticMarkup 语法
- **时间戳**：每条修订自动附带时间戳注释
- **视觉渲染**：编辑器内直接渲染删除线、高亮等样式
- **接受/拒绝**：支持逐条（光标处）或全部接受/拒绝修订
- **右键菜单**：编辑器右键可快速接受/拒绝当前修订

## CriticMarkup 语法

| 操作 | 语法 | 效果 |
|------|------|------|
| 新增 | `{++新文字++}` | 绿色下划线 |
| 删除 | `{--旧文字--}` | 红色删除线 |
| 替换 | `{~~旧~>新~~}` | 删除线 + 高亮 |
| 评论 | `{>>评论<<}` | 蓝色气泡 |
| 高亮 | `{==文字==}` | 黄色高亮 |

## 命令

- `Toggle revision tracking` — 开关修订模式
- `Accept all changes` — 接受全部修订
- `Reject all changes` — 拒绝全部修订
- `Accept change at cursor` — 接受光标处修订
- `Reject change at cursor` — 拒绝光标处修订
- `Add comment at selection` — 给选中文字添加评论

## 安装

1. 将 `manifest.json`, `main.js`, `styles.css` 放入 `.obsidian/plugins/critic-track/` 目录
2. 在 Obsidian 设置中启用插件
3. 可选：在设置中配置时间戳格式和作者标签

## 构建（开发用）

```bash
npm install
npm run build
```

## 设置

- **Enable timestamps**：是否给每条修订附带时间戳
- **Timestamp format**：时间戳格式（YYYY-MM-DD HH:mm）
- **Enable author tag**：是否附带作者标签
- **Author tag**：作者名称
