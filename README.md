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

酒馆聊天消息中的 `image###提示词###` 标记会被渲染为「轻绘生图」按钮；点击后才会提交当前提示词到已配置的 NovelAI 官网或第三方接口，并把生成图片插入同一条消息正文。不会在流式输出时自动请求生图。可在扩展设置中配置 OpenAI 兼容图像接口，或选择 NovelAI。NovelAI Vibe 只接受已编码资源；智绘姬标准 `vibeData` 中 `identifier: novelai-vibe-transfer` 的 `image` 会作为编码载荷，预览图单独保留。Vibe 组内每条参考可单独设置强度，Information Extracted 在编码后保持只读；普通预览图不会被冒充为编码输入。


## 工作区分区

- **生图**：图片展示区、Tag 编辑、画师串/Vibe 选择，以及 GPT/OpenAI 兼容与 NovelAI 的模型参数。
- **预设**：分为画师串编辑、Vibe 管理、角色卡绑定三个子页；角色切换时会尝试应用已保存的画师串/Vibe 组合。
- **Vibe 导入**：支持 JSON / 智绘姬组格式；`.naiv4vibe` / `.naiv4vibeBundle` 会尝试读取其中的 JSON 资源。图片编码按钮调用 `/api/novelai/encode-vibe`，需要酒馆后端实际提供该代理路由；标准酒馆未必提供此路由，若缺失会明确报错，不会伪装成编码成功。V4 预编码 Vibe 仅用于兼容的 NovelAI V4/V4.5 模型，不能把编码当作普通图片或跨模型通用资源。

## 状态

当前为测试版本。代码已放入独立仓库，但仍需在实际 SillyTavern 环境中验证加载、设置保存、消息触发及 NovelAI Vibe 请求兼容性；仓库创建不代表这些项目已经通过实机测试。

## 许可

本项目包含既有代码及其许可声明，请一并阅读仓库中的 `LICENSE` 文件。
