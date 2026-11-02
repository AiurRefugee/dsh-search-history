# DSH Search History

DeepSeek Harness Web 聊天记录全文搜索。目标宿主为 0.2.1-rc.3。

## 安装

仓库包含已构建的客户端。在安装 DSH 的机器上运行：

```sh
git clone https://github.com/AiurRefugee/dsh-search-history.git
npm ci --prefix ./dsh-search-history
dsh plugin --profile web add "$(pwd)/dsh-search-history"
```

启用插件后重启 Web 服务并刷新页面。若已启用 dsh-find-all、dsh-find-bar 或其他占用相同快捷键的搜索插件，请先停用。

## 使用

- 点击侧栏顶部导航的「全局搜索」或按 Ctrl/Cmd + K 打开搜索面板。输入中文、英文或代码片段，按工作区和会话识别每条命中消息。点击正文片段，插件打开会话、加载所需的历史并以 200ms 减速滚动到该消息，保持会话内查找栏关闭。仅标题命中时打开会话。
- 在聊天页按 Ctrl/Cmd + F 查找当前会话。Enter 和 Shift + Enter 切换匹配，Esc 关闭。搜索用户消息和助手正文，排除推理内容。
- Agent 可以调用只读工具 `search_chat_history`，必填参数为 `query`，可选 `session_id`。搜索限于调用方工作区中的未归档普通会话。返回片段、消息 ID、会话 ID 和事件序号。
- 全局搜索按批读取已保存的会话。单条消息显示一个摘要，单会话最多返回 500 条命中消息。Agent 每次最多返回 100 条，达到限制或读取失败时响应带有 `incomplete`。默认搜索全部工作区的未归档普通会话。

## 开发

```sh
npm ci
npm test
npm run build
npm run check:build
```

客户端和历史读取适配器源自 MIT 项目 [Ryuu-64/dsh-find-all](https://github.com/Ryuu-64/dsh-find-all)，保留其上游版权和致谢。当前分支增加全局快捷键、逐消息结果、历史定位和 Agent 工具。
