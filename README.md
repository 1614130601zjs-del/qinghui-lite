# 轻绘 Lite

轻量化 SillyTavern 生图扩展，独立安装仓库。

## 安装

在 SillyTavern 的扩展目录中执行：

```bash
git clone https://github.com/1614130601zjs-del/qinghui-lite.git qinghui-lite
```

随后重启或刷新 SillyTavern，并在扩展设置中检查「轻绘 Lite」。

## 文件

- `manifest.json`：酒馆扩展清单
- `index.js`：扩展入口、设置界面、生图请求和消息触发
- `trigger-core.js`：标记解析与触发任务状态管理
- `extension.css`：设置面板和聊天图片样式

## 使用说明

消息中的 `image###提示词###` 标记可触发生图。可在扩展设置中配置 OpenAI 兼容图像接口，或选择 NovelAI。NovelAI Vibe 数据若无法识别出可发送的编码图像，扩展会提示错误，不会把预览缩略图冒充为 Vibe 输入。

## 状态

当前为测试版本。代码已放入独立仓库，但仍需在实际 SillyTavern 环境中验证加载、设置保存、消息触发及 NovelAI Vibe 请求兼容性；仓库创建不代表这些项目已经通过实机测试。

## 许可

本项目包含既有代码及其许可声明，请一并阅读仓库中的 `LICENSE` 文件。
