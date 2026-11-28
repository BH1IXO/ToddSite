# Todd个人主页

无依赖的 Node 站点（Node 18+）。站点内容在 `data/site.json`，文章在 `data/posts/*.json`，都通过 `/admin` 用密码在线修改。

## 页面结构

介绍 → 做过的和正在做的（六个方向，项目挂在方向下）→ 课程 → 文章 → 生活 → 合作 → 跟我聊聊（AI 分身对话框）。

## 环境变量

- `ADMIN_PASSWORD` 必填，后台密码，只从环境变量读取，代码里没有默认值；没设置服务直接拒绝启动。建议 16 位以上随机串，少于 12 位启动时会告警。
- `DEEPSEEK_API_KEY` 可选，分身对话用。只在服务端使用，不会出现在网页里。
- `DEEPSEEK_MODEL`、`DEEPSEEK_API_URL` 可选，默认 deepseek-chat 与官方地址。
- `PORT` 默认 3000；`TRUST_PROXY=1` 在反向代理后面时设置（N 层代理写 N）。会取 `X-Forwarded-For` 从右数第 N 个值，所以 nginx 要配 `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`。在 nginx 后面却没设它，所有访客都会被当成 127.0.0.1，锁定会波及所有人（日志里会告警）。
- `KB_DIR` 可选，知识库目录，默认 `data/kb`。测试用临时目录时不污染正式数据。

## 后台登录防护

- 同一 IP 15 分钟内输错 5 次即锁定 15 分钟；锁定期间连正确密码也不接受。解锁后再被锁，时长依次翻倍（30 分钟、1 小时……最长 24 小时），登录成功或 24 小时内没再被锁则清零。
- 每次尝试（成功、失败、锁定中被拒、退出）都追加一行 JSON 到 `data/logs/admin-login.log`：时间、IP、User-Agent、结果，不记密码和 token。超过 5MB 轮转为 `.1`。查看：`tail -f data/logs/admin-login.log`。
- 会话 token 自登录起 12 小时有效，到期失效需重新登录；退出即作废；同时最多 20 个会话。服务重启后所有会话失效。
- 可调参数（一般不用改）：`LOGIN_MAX_FAILS`（5）、`LOGIN_WINDOW_MINUTES`（15）、`LOGIN_LOCK_MINUTES`（15）、`SESSION_TTL_HOURS`（12）、`LOGIN_LOG_FILE`。
- 测试：`node test/auth.test.js && node test/login.e2e.js`（CI 里也会跑）。

## 博客

后台“文章管理”可新建、编辑、存草稿、删除，正文空行分段，`#` 开头的行是小标题。每篇文章网址是 `/post/ID`。

## 分身对话

- 回答前先从知识库检索与问题最相关的几段资料拼进提示词，不再整份倒给模型；知识库为空时自动用网站已公开内容初始化。
- 资料来自知识库（`data/kb/`，不进仓库）：网站正文、已发布文章，以及用命令行写入的档案、经历、观点。
- 限流：每 IP 每分钟 6 条、每天 40 条，全站每天 500 条（成功才计数）。
- 提示词在 `server.js` 的 `persona()` 里，可按需调整语气。「身份与经历要点」（`site.json` 的 `facts`）每次都会带进提示词，问职位、在哪工作时以它为准；课程名、工作方向名会明确告诉模型不是职位。
- 流式输出按整句/整短语往外送（`lib/chunker.js`）：切点只落在标点上，不劈开英文单词和联系方式，每块再过一遍脱敏。测试：`node test/chunker.test.js`。

## 知识库

零依赖，只用 Node 内置模块（Node 18+）。存储和检索按大语料设计，但小数据同样直接可用。

**结构**

- 正文切块（约 700 字一块）追加写入 `data/kb/docs/seg-N.jsonl`，每块在文件里的字节偏移记在 `seg-N.map`，检索时按偏移随机读，不整段扫。
- 检索用 BM25 倒排索引：中文按相邻二字组、英文数字按词，不依赖词典，也不需要向量服务。词表按哈希分 64 个分片，查询只读命中词所在分片。
- 单段到 2 万块或 64MB 自动换新段；批量导入每 32 篇合并写一次索引。删除记墓碑、检索时过滤，`compact` 再真正重写。
- 50MB 合成语料实测：入库约 73 秒，索引约 38MB，常见词检索中位 52ms。

**写入（命令行，自动更新索引，无需表单）**

```bash
# 单条写入（默认走线上 https://aiucc.cn，需要 ADMIN_PASSWORD 环境变量或已有 token）
ADMIN_PASSWORD=… node scripts/kb.js add --title "个人履历" --file 档案.md --kind 履历 --trust chat

# 长文档按二级/三级标题拆成多篇
ADMIN_PASSWORD=… node scripts/kb.js add --title "经历" --file 经历.md --split

# 把网站内容和已发布文章灌入/刷新（同一 id 覆盖，可重复执行）
ADMIN_PASSWORD=… node scripts/kb.js seed

# 验证检索效果
ADMIN_PASSWORD=… node scripts/kb.js search "在世纪互联负责什么" --k 5

# 列表、统计、删除、整理
node scripts/kb.js list | stats | rm <id> | compact
node scripts/kb.js quarantine          # 查看被隔离的段落
```

本机调试加 `--local` 直接读写 `data/kb/`，不经过服务器。

**隐私与清洗（入库前）**

- 原地抹掉：邮箱、手机/座机、身份证、银行卡、微信/QQ、住址、密钥；真实客户名按 `data/kb/private/blocklist.txt`（每行一个，不进仓库）替换成“某客户”。
- 整段隔离：私事、对他人的负面评价、未公开商业信息（融资、合同、报价、营收等），以及手动标了 `[私密]`/`[内部]` 的段落。被隔离的段落不进检索库，只留在 `data/kb/quarantine/` 等人工复核。
- `trust` 取值：`public`（网站正文、已发布文章，只做联系方式清洗）、`chat`/`note`/`unknown`（档案、聊天记录等，两层都做）。
- 公开接口响应再过一遍脱敏：检索结果、聊天流式输出都不会出现联系方式。

**后台**

`/admin/kb` 只读查看：统计、全部文档、关键词试检索、隔离区。写入只走命令行。

## 部署

需要能长期运行 Node 并有可写磁盘（云服务器、Railway、Render、Fly.io 持久卷）。必须 HTTPS；`data/` 放持久盘；每次保存站点会在 `data/backup/` 留最近 30 份。
