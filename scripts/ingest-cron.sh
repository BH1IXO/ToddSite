#!/bin/bash
# 8 小时一次的调度入口：只负责跑一次，不自己循环。由 launchd 或外部 cron 定时调用。
# launchd / cron 的 PATH 很短，这里补上常见的 node 安装位置
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
echo "===== $(date '+%Y-%m-%d %H:%M:%S') 开始灌入 =====" >> logs/ingest.log
node scripts/fetch-sources.js >> logs/ingest.log 2>&1
rc=$?
echo "===== $(date '+%Y-%m-%d %H:%M:%S') 结束（退出码 ${rc}） =====" >> logs/ingest.log
exit $rc
