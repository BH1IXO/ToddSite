# Todd个人主页

无依赖的 Node 站点（Node 18+）。站点内容在 `data/site.json`，文章在 `data/posts/*.json`，都通过 `/admin` 用密码在线修改。

## 页面结构

介绍 → 做过的和正在做的（六个方向，项目挂在方向下）→ 课程 → 文章 → 生活 → 合作 → 跟我聊聊（AI 分身对话框）。

## 环境变量

- `ADMIN_PASSWORD` 必填，后台密码。
- `DEEPSEEK_API_KEY` 可选，分身对话用。只在服务端使用，不会出现在网页里。
- `DEEPSEEK_MODEL`、`DEEPSEEK_API_URL` 可选，默认 deepseek-chat 与官方地址。
- `PORT` 默认 3000；`TRUST_PROXY=1` 在反向代理后面时设置。

## 博客

后台“文章管理”可新建、编辑、存草稿、删除，正文空行分段，`#` 开头的行是小标题。每篇文章网址是 `/post/ID`。

## 分身对话

- 资料来自网站内容（简介、方向、项目、课程、合作、已发布文章的标题和简介），不读任何私人数据。
- 限流：每 IP 每分钟 6 条、每天 40 条，全站每天 500 条（成功才计数）。
- 提示词在 `server.js` 的 `persona()` 里，可按需调整语气。

## 部署

需要能长期运行 Node 并有可写磁盘（云服务器、Railway、Render、Fly.io 持久卷）。必须 HTTPS；`data/` 放持久盘；每次保存站点会在 `data/backup/` 留最近 30 份。
