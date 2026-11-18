# 从云端 Claude 打开 Windows 本地预览

云端 Claude Code 调用 MCP 工具，Windows 通过已有的 Cage SSH 连接接收请求。在本机独立 Edge 窗口打开页面后，工具把标签页 ID、标题和 URL 返回给 Claude。

## 启动

Windows 端需要 Python 3.9+、OpenSSH 客户端、Microsoft Edge 和 Cage 中已配置密钥认证的云主机。客机需要 Python 3 和 Claude Code。以下 PowerShell 命令在本目录运行。

1. 启动本地预览服务。例如在另一个终端进入静态网站目录，运行：

   ~~~powershell
   python -m http.server 18786 --bind 127.0.0.1
   ~~~

2. 从 Cage 本地主机列表选择目标，将客机脚本复制过去：

   ~~~powershell
   $hostsFile = "$env:USERPROFILE/.claude-cage/desktop-entry/remote-hosts.json"
   (Get-Content -Raw $hostsFile | ConvertFrom-Json).hosts | Select-Object id,host
   $cageHostId = Read-Host "输入目标主机 ID"
   python windows.py --host-id $cageHostId --install
   ~~~

3. 在 Cage 客机的 Claude 项目目录运行一次：

   ~~~sh
   claude mcp add --scope local windows-browser-preview -- python3 /home/cage/.local/share/windows-browser-preview/guest.py
   ~~~

4. 在 Windows 终端连接并保持运行：

   ~~~powershell
   python windows.py --host-id $cageHostId --port 18786
   ~~~

   看到 Connected 后，在上述项目中新开 Claude Code 会话，输入「用 windows-browser-preview 的 open_page 打开 http://127.0.0.1:18786/ ，再用 read_tab 告诉我 Windows 标签页的标题」。两次操作会在 Windows 终端打印同一标签页 ID。

## 操作范围

- open_page 接受配置端口上的 http://127.0.0.1 地址。首次调用启动独立的 Edge 窗口，后续调用打开新标签。
- read_tab 读取最近一次打开的预览标签。关闭标签页后，可用 open_page 再次打开。
- Windows 终端按 Ctrl+C 断开桥接。预览窗口可手动关闭。临时浏览器配置保存在系统临时目录的 cage-preview-edge-* 下。
- --profile 可指定存放 desktop-entry/remote-hosts.json 的 Cage 配置目录。--port 指定已有站点的端口。
