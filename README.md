# AI 文献助手（Zotero 7）

## 安装与构建

执行 `npm install`、`npm run build`，然后在 Zotero 7 的“工具 → 插件 → 从文件安装插件”选择根目录的 `ai-literature-assistant.xpi`。

插件的 `update_url` 指向本仓库 `main` 分支的 `update.json`。安装 0.1.3 或更新版本后，Zotero 会通过该文件检查新版本。

发布后续版本时运行 `npm run release:patch`，构建脚本会更新 XPI 和带 SHA-256 校验值的 `update.json`；然后将 `package.json`、`package-lock.json`、源码、XPI 和 `update.json` 一起提交并推送到 `main`。仅替换 XPI 而不提高版本号，Zotero 不会识别为更新。

## 配置

在 Zotero 设置的“AI 助手”Pane 中填写兼容 OpenAI Chat Completions 的 API URL、Key、Model。领域可选自动、cv、llm、llm_app、neuro；全文长度上限默认 30000 字符。联网可选 Tavily、Serper 或自定义 POST 搜索 API（接收 `{query,count}` 并返回 `results` 数组）。不配置搜索 Key 时自动关闭联网。

使用 DeepSeek（DS）时，将“模型服务”选为 **DeepSeek (DS)**，填入 DeepSeek API Key。若 API URL 和 Model 仍为初始默认值，插件会自动使用 `https://api.deepseek.com/chat/completions` 与 `deepseek-flash`；也可把 Model 改成 `deepseek-v4-pro`。流式响应只展示最终回答内容，思考过程不会写入报告或对话。自定义 API URL 和模型名称会保留。

切换 OpenAI / DeepSeek 时，设置页会立即切换到对应的 API URL 和模型名称；每个服务商单独记住上次填写的自定义 URL 与模型。API Key 仍为共用字段，切换服务商后请确认 Key 与所选服务商匹配。

## 使用

选中文献条目，展开右侧“AI 总结”，点击“生成/更新总结”。报告保存在条目下的 `AI Literature ai_summary.json` 附件，字段为 `ai_summary`（Markdown 文本）。可在侧栏滚动查看或点击“在新窗口打开”。

在 PDF 阅读器顶部点击 **AI 助手** 按钮可定位到右侧“AI 总结”面板。若右侧面板整体被收起，请先用 Zotero 阅读器右侧的面板开关将其展开。

在 PDF 中划词后，气泡工具栏提供“加入对话”和“提问”。前者积累上下文，后者把选中内容放入当前文献的提问上下文。右侧输入问题后点击“发送”，答案逐字显示；对话保存在 `AI Literature ai_conversation.json` 附件。搜索失败时会改为仅基于文献回答。

## 已知限制

PDF 必须能由 Zotero 提取文本。API Key 存在 Zotero 首选项中。当前构建未经过 Zotero GUI 中的真实论文验证。
