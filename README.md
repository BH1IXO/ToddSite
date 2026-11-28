# Todd个人主页

无依赖的 Node 站点（Node 18+）。站点内容在 `data/site.json`，文章在 `data/posts/*.json`，都通过 `/admin` 用密码在线修改。

## 页面结构

介绍 → 做过的和正在做的（六个方向，项目挂在方向下）→ 课程 → 文章 → 生活 → 合作 → 跟我聊聊（AI 分身对话框）。

## 环境变量

- `ADMIN_PASSWORD` 必填，后台密码，只从环境变量读取，代码里没有默认值；没设置服务直接拒绝启动。建议 16 位以上随机串，少于 12 位启动时会告警。
- `DEEPSEEK_API_KEY` 可选，分身对话用。只在服务端使用，不会出现在网页里。
- `DEEPSEEK_MODEL`、`DEEPSEEK_API_URL` 可选，默认 deepseek-chat 与官方地址。
- `PORT` 默认 3000；`TRUST_PROXY=1` 在反向代理后面时设置（N 层代理写 N）。会取 `X-Forwarded-For` 从右数第 N 个值，所以 nginx 要配 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`。在 nginx 后面却没设它，所有访客都会被当成 127.0.0.1，锁定会波及所有人（日志里会告警）。

## 后台登录防护

- 同一 IP 15 分钟内输错 5 次即锁定 15 分钟；锁定期间连正确密码也不接受。解锁后再被锁，时长依次翻倍（30 分钟、1 小时……最长 24 小时），登录成功或 24 小时内没再被锁则清零。
- 每次尝试（成功、失败、锁定中被拒、退出）都追加一行 JSON 到 `data/logs/admin-login.log`：时间、IP、User-Agent、结果，不记密码和 token。超过 5MB 轮转为 `.1`。查看：`tail -f data/logs/admin-login.log`。
- 会话 token 自登录起 12 小时有效，到期失效需重新登录；退出即作废；同时最多 20 个会话。服务重启后所有会话失效。
- 可调参数（一般不用改）：`LOGIN_MAX_FAILS`（5）、`LOGIN_WINDOW_MINUTES`（15）、`LOGIN_LOCK_MINUTES`（15）、`SESSION_TTL_HOURS`（12）、`LOGIN_LOG_FILE`。
- 测试：`node test/auth.test.js && node test/login.e2e.js`（CI 里也会跑）。

## 博客

后台“文章管理”可新建、编辑、存草稿、删除，正文空行分段，`#` 开头的行是小标题。每篇文章网址是 `/post/ID`。

## 分身对话

- 资料来自网站内容（简介、方向、项目、课程、合作、已发布文章的标题和简介），不读任何私人数据。
- 限流：每 IP 每分钟 6 条、每天 40 条，全站每天 500 条（成功才计数）。
- 提示词在 `server.js` 的 `persona()` 里，可按需调整语气。

## 部署

需要能长期运行 Node 并有可写磁盘（云服务器、Railway、Render、Fly.io 持久卷）。必须 HTTPS；`data/` 放持久盘；每次保存站点会在 `data/backup/` 留最近 30 份。
