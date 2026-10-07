# 给在这个仓库里干活的 Claude：先读这个

这是用户电脑上「REIZE助手」（本地 AI）的程序。用户电脑是 Windows，程序装在 `D:\ai网站\本地AI`，
用户不会手动打补丁、不会用 git。**用户只认一行更新指令。**

## 发布分支

`claude/upbeat-dijkstra-weod9v` 是发布分支：`update-agent.ps1` 从这个分支下载程序文件。
用户电脑上跑的就是这个分支的代码。

## 每次修改都要按这个流程（2026-10-07 用户定的规则）

1. **开工前**：`git fetch origin claude/upbeat-dijkstra-weod9v`，把它合并进自己的分支，在最新代码上改。
   不要在默认分支或其他旧分支的老代码上改，否则会把别的对话框做好的东西冲掉。
2. **改完**：`node --check agent/*.js` 过了再提交，推送自己的分支。
3. **发布**：把改动推到发布分支：`git push origin HEAD:claude/upbeat-dijkstra-weod9v`。
   推不上（别的对话框刚推过）就先 `git fetch` + 合并发布分支，再推。**绝对不要 force push。**
4. 新增或改动了 `agent/` 里 `server.js、core.js、auto.js、power.js、ui.html` 之外的程序文件，
   要把它加进 `update-agent.ps1` 的 `$files` 列表，否则用户那边拿不到。
   不要把 `config.json`、`state.json` 加进去（会冲掉用户的设置）；需要新配置项时，代码里给默认值。
5. 用 `curl` 确认 `https://raw.githubusercontent.com/cckandxx-glitch/cck/claude/upbeat-dijkstra-weod9v/agent/<文件>` 已经是新内容。
6. **最后回复用户时，一定附上这行更新指令**（不要给补丁、不要给手动修改步骤）：

```powershell
irm https://raw.githubusercontent.com/cckandxx-glitch/cck/claude/upbeat-dijkstra-weod9v/update-agent.ps1 | iex
```

   并用一两句中文说清楚这次更新改了什么、更新后要怎么测试。

## 其他

- 改 `agent/ui.html`、`agent/server.js` 前读 `agent/_请勿覆盖-先读我.md`：只局部修改，不许整份覆盖。
- 回复用户用中文。
