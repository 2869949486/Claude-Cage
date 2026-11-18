# 官网使用答疑

访客从首页或使用手册进入 `/ask/`。页面保留最近两轮对话供追问，刷新后清空。勾选联网时，服务会用当前问题检索 Microsoft Learn 和中文维基百科。

## 更新规则

生产服务每次接受提问时读取 `/opt/cage-support/rules.md`。可以在本机编辑 Markdown，然后用以下命令应用。临时文件和目标文件位于同一目录，替换完成后下一次提问就会使用新规则。

```sh
ssh token-link-server 'set -eu; tmp=$(mktemp /opt/cage-support/rules.XXXXXX); cat > "$tmp"; chmod 644 "$tmp"; mv "$tmp" /opt/cage-support/rules.md' < 官网答疑规则.md
```

## 更新程序和知识库

在仓库根目录执行以下命令。将生成的程序、语料及其提交标识同步到服务器的 `/opt/cage-support/`，再重启 `cage-support.service`。语料取自指定提交，包含使用手册和应用源码。源码引用指向该提交的具体行。

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/server ./www/support
bash www/support/build-corpus.sh origin/main /tmp/corpus.tar.gz
```

首次安装时创建空的 `/opt/cage-support/rules.md`，并将 `TOKEN_LINK_API_KEY` 写入仅 root 可读的 `/etc/cage-support/model.env`。服务调用 `api.token-link.shop` 的 `deepseek-flash`。将同目录的 systemd 单元安装到 `/etc/systemd/system/`。

HTTPS 入口 `https://token-link.shop/cage-support/ask` 将该路径改写为 `/ask` 并转发至 `127.0.0.1:18152`。代理必须用连接对端 IP 覆盖 `X-Real-IP`。服务每个来源 IP 每小时接受 20 次请求，全部访客每天合计 600 次，同时处理 5 个问题。计数以 UTC 整点和自然日为界，服务重启会重置计数。
