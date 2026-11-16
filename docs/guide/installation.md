---
title: 安装与首次启动
description: 安装适合电脑的 Cage，选择客机系统和数据盘，完成第一次环境启动。
group: 开始使用
order: 1
keywords: 下载 安装 客机 macOS Windows Debian Apple Silicon Hyper-V WHPX KVM 账户 密码 镜像 继续安装
---
## 选择安装包

从[官网下载区](https://claude-cage.com/#download)选择平台。公开附件、签名和校验文件以 [GitHub Releases](https://github.com/Lee-xeo/Claude-Cage/releases)为准。源码压缩包用于开发，不能直接安装。

| 平台 | 要求与安装方式 |
| --- | --- |
| macOS | Apple Silicon、macOS 14+。打开 `.dmg`，将 Cage 拖入“应用程序”，再从那里启动。Intel Mac 暂不支持。 |
| Windows | Windows 10 22H2 / 11、x64。运行 `.exe` 安装器，按所选客机准备 Hyper-V 或 Windows 虚拟机监控程序平台，并在系统要求时重启。未签名预览包会明确标注。 |
| Linux | Debian 12 / Ubuntu 22.04 / 24.04、x86_64。需要 KVM 与当前用户的访问权限。执行 `sudo apt install ./Cage-<版本>-linux-amd64.deb` 补齐应用依赖，再从应用菜单打开。 |

Windows ARM64 和 Linux ARM64 暂不支持。平台依赖详情见 [Windows 指南](https://github.com/Lee-xeo/Claude-Cage/blob/main/docs/windows.md)与 [Linux 指南](https://github.com/Lee-xeo/Claude-Cage/blob/main/docs/linux.md)。

这里选择的是运行 Cage 的主机平台。虚拟机里的客机系统在首次创建环境时选择：Apple 芯片 Mac 可用 macOS 或 Debian；具备完整 Hyper-V 的 Windows 11 专业版、企业版和教育版可用 Windows 11 或 Debian；Linux 主机可选择与本机同发行版的系统或 Debian 13。具体组合见[选择客机系统](guest-systems.md)。Cage 的 macOS 14+ 运行要求与系统克隆条件分别判断；当前 Mac 克隆入口要求 macOS 26.4+。

<figure class="guide-shot">
  <a href="../../www/public/docs/screenshots/account-setup.jpg" target="_blank" rel="noopener" aria-label="查看原图：首次创建 Cage 账户"><img src="../../www/public/docs/screenshots/account-setup.jpg" alt="首次创建 Cage 账户" width="2560" height="1764" loading="lazy" decoding="async" /></a>
  <figcaption>首次创建 Cage 账户。截图版本：0.1.6-alpha-preview（开发构建） · macOS 原生应用 · 2026-11-07。<a href="../../www/public/docs/screenshots/account-setup.jpg" target="_blank" rel="noopener">查看原图（2560 × 1764） ↗</a></figcaption>
</figure>

## 创建 Cage 账户

选择用户名和密码登录时，设置用户名和至少 8 个字符的密码。这个账户用于解锁当前 Cage，Claude 订阅需要另外在环境里登录。注册后请保存恢复密钥，忘记密码时可在登录页使用它重置；保存与补设步骤见[账户恢复](settings.md#保存恢复密钥)。

包含本机信任登录的较新桌面构建还可选择“信任此电脑并进入”，也可选“使用用户名和密码”进入下图所示的流程。已有密码账户保持原来的登录方式；本机信任的适用范围见[受信任的本机登录](https://github.com/Lee-xeo/Claude-Cage/blob/main/docs/getting-started.md#受信任的本机登录)。

完整桌面版在创建密码账户时默认勾选“记住我”，可以取消；已有账户可在登录页或“设置 → 账户”调整。macOS 另可开启 Touch ID。手动锁定后仍需验证，退出账户会撤销快捷登录授权。账户密码不会加密整个项目目录或虚拟磁盘。

若以前已有账户，现在再次出现创建页面，先停止操作并查[数据目录问题](troubleshooting.md#原账户与数据看不见了)。

## 初始化系统与存储

首次登录后，Cage 显示独立的初始化界面。先选择适合项目的客机系统，可选择“自动匹配本机系统版本”或具体系统。自动匹配在下一步显示对应的官方镜像，安装干净的独立系统，主机个人文件与登录资料不会复制。以后启动沿用原系统和磁盘，更新 Cage 不会替换客机系统。

想使用虚拟 Mac 时，选择“macOS”或“自动匹配本机系统版本”；Debian 和 Ubuntu 是 Linux 系统。如果本机已经有 Apple 的 `.ipsw` 系统镜像，选择“macOS”后点击“选择本机 IPSW”直接使用，避免重复下载。下载开始后仍可先停止安装；只要尚未创建系统磁盘，就能通过“改用已有镜像或重新选择系统”返回修改。已有系统磁盘的环境继续原安装，不提供重新选择入口。

“存储目录”已填入默认位置。需要更换时直接编辑，或点击“选择文件夹”选定本地磁盘上的专用空文件夹；点击“下一步：配置代理”时保存，目录无效时留在当前页提示修改。Windows 安装器里的程序目录与环境数据目录分开；例如应用装在 C 盘，环境可放在 `D:\CageData`。

Mac、Linux 使用默认配置时，环境数据放在用户主目录的 `.claude-cage/state`。Windows 正式安装版在首次初始化时，默认填入安装目录下的 `CageData`，例如应用装在 `D:\Cage`，环境数据就放在 `D:\Cage\CageData`；没有写入权限时，在当前字段选择其他有权限的本地文件夹。已有环境继续使用原存储位置，不会自动迁移。更新或覆盖安装时，安装目录下的 `CageData` 保持原位，不随程序文件移动，虚拟磁盘路径不变。账户与配置仍保存在用户目录的 `.claude-cage`。

初始化页显示本机完整路径。系统镜像、后续镜像下载缓存与持久虚拟磁盘使用同一存储位置；旧版本已留在系统缓存目录的文件不自动移动或删除。更新、重装与卸载应用保留环境数据目录，重新安装后可以继续使用已有数据。不要手动删除这个目录。

选择支持权限管理与稀疏文件的磁盘：Windows 可用 NTFS，Linux 可用 ext4 / XFS / Btrfs，macOS 使用已启用所有权的 APFS。不要选择磁盘根目录、网络盘、已有项目或应用安装目录。已有环境换盘请按[存储迁移](maintenance.md#迁移环境到另一块磁盘)操作。

## 导入代理并启动

1. 点击“下一步：配置代理”。在“从已有代理软件导入”中，找到已有配置并点击“导入此配置”，无需自己查找文件。未找到时，可点击“添加来源”，使用订阅链接、配置文件或手动节点。详细步骤见[网络与代理](network.md)。
2. 选择最终出口，点击“应用代理”。Cage 使用独立核心，不会自动采用本机 Clash 当前所选节点。
3. 核对匹配的系统镜像、下载量和空间要求，点击“开始安装”。
4. 留在初始化界面查看下载、校验、系统安装和工具配置进度。这些步骤自动完成，需要你操作时会显示具体指引。macOS 的系统权限与文件夹授权见下方说明。失败时按当前步骤的提示重试；“操作详情”显示具体错误与检查结果，完整记录可在“日志与诊断”导出。已完成系统安装的环境无需重新下载或安装。
5. 客机可用且网络与隔离检查通过后，点击“进入工作台”。以后打开 Cage 直接进入原工作台，环境停止时可以直接启动使用。只需连接远程服务器时，初始化界面的“只连接 SSH 主机”可跳过本机安装。

安装、启动与项目共享不要求修改主机全局 Git 配置，也不要求为裸仓库保护升级 Git。

## macOS 安装后需要你确认的设置

系统和工具安装完成后，Cage 会打开虚拟 Mac 的设置画面。下面的操作都在这张画面内完成；按顺序打开当前所需的开关，通过检查后会自动进入下一项。

| 当前步骤 | 用途与操作 |
| --- | --- |
| 窗口录制 | 用于在 Cage 中显示设置与授权画面。找到 `Cage Guest Window` 并打开开关；如果提示“退出并重新打开”，点击它，等待画面重新连接。 |
| 辅助功能 | 用于在 Cage 中点击虚拟 Mac 的按钮、输入文字。找到 `Cage Guest Window` 并打开开关。 |
| 文件系统扩展 | 用于访问你允许使用的本机文件夹。打开 `macFUSE` 和 `macFUSE (local)` 两个开关；如果先出现安装器，按指引完成安装，随后再开启开关。 |
| 屏幕共享 | 用于连接虚拟 Mac 的桌面。打开“屏幕共享”并允许当前普通用户访问，再点击“已开启，重新检查”。 |

如果系统弹出管理员认证，用户名填写 `cagesetup`。先在系统窗口选中密码框，再点击画面上方的“填写授权密码”，最后在系统窗口确认。使用密码账户时，也可输入 Cage 账户密码。“返回设置指引”可以回到步骤列表，安装进度会保留。

系统权限通过后，如出现“允许使用这个文件夹”，先核对页面显示的文件夹，再点击“允许使用此文件夹”。这次授权允许虚拟 Mac 中的终端和编辑器读写所示文件夹及其内容，其中的修改会同步到本机。页面显示的默认文件夹可以直接使用；希望使用其他项目时，可进入工作台后添加。

授权后会自动验证文件夹访问并继续联网检查。如果未继续，可展开“查看 macOS 授权窗口 / 已允许但未继续？”，在画面右下角点击 `Use Project`，再点击“我已允许，重新检查”。系统窗口已定位到正确目录，列表为空也可以允许，无需重新选择文件夹。点击“暂不授权”会返回安装检查页，已有安装进度和文件保留；之后可再次打开授权。

## 第一次启动需要等待什么

首次安装内容取决于客机系统。克隆入口优先复用已校验的匹配材料，缺少时下载官方镜像。macOS 使用 Apple IPSW；Windows 克隆使用匹配的 Microsoft ESD，手动安装可选择官方 ISO；Linux 克隆使用对应发行版的云镜像。Debian 13 基础镜像约 320–325 MiB，开发工具另行安装。镜像来源、系统许可和存储要求见[客机系统指南](guest-systems.md#下载量与磁盘空间)。

系统镜像、镜像版本目录和在主机上预备的 macOS 应用与开发工具包通过主机网络下载，遵循主机代理设置；未配置代理时直连官方源。使用 Clash 等软件时，可开启其系统代理或 TUN，实际出口由该软件对下载网站的规则决定。已选择的主机代理连接失败、明确配置的 PAC 解析失败时，下载会报错，不自动回退直连。客机内的进程和下载任务使用 Cage 的独立代理，官方源与备用镜像的选择及平台设置见[系统镜像的下载网络](network.md#系统镜像的下载网络)。

Debian 初始虚拟磁盘容量上限为 24 GiB，macOS 和 Windows 需为系统及开发工具留出更多空间。实际占用随安装和使用增加，创建前查看所选版本的要求。Claude Desktop 按需单独下载。随后启动会复用工具、文件与登录资料。

应用内准备有固定摘要的 Linux 开发工具包、macOS 应用与开发工具包、Windows 原生工具包时，剩余下载量达到 8 MiB 会尝试最多 4 连接分段下载。小文件、无法取得文件长度或服务器不支持分段时使用单连接。所有连接沿用对应下载任务的代理设置，收齐后校验整份文件，校验成功才用于安装。

Claude Code 和 Claude Desktop 在实际下载安装时查询官方最新版本；已安装的更新版本会保留。环境版本页显示这一下载策略，客机中的版本号以实际安装结果为准。

下载中断时查看错误，修复网络或磁盘空间后点“继续安装”。已有连续进度和已保存的分段会用于续传；即使剩余不足 8 MiB，也会继续复用分段。摘要不符或服务器不支持续传时，从头下载该文件。Claude Desktop 和 Chrome 的官方最新安装包没有预先固定的摘要，中断后可能需要重新下载整个安装包。不要通过清空 `.claude-cage` 或重建账户解决安装失败。

下载时显示已接收字节、可取得的总量与采样速度；校验单独显示处理进度。系统恢复和工具安装没有可测总量时显示阶段。继续安装沿用原安装身份、系统选择和已创建磁盘。

<figure class="guide-shot">
  <a href="../../www/public/docs/screenshots/windows-native-download.png" target="_blank" rel="noopener" aria-label="查看原图：Windows 原生应用首次下载镜像的进度"><img src="../../www/public/docs/screenshots/windows-native-download.png" alt="Windows 原生应用首次下载镜像的进度" width="750" height="320" loading="lazy" decoding="async" /></a>
  <figcaption>Windows 原生应用首次下载镜像的进度。截图版本：0.1.5-alpha.2（测试构建） · Windows 11 x64 原生应用 · 2026-11-06。<a href="../../www/public/docs/screenshots/windows-native-download.png" target="_blank" rel="noopener">查看原图（750 × 320） ↗</a></figcaption>
</figure>

## 完成第一项工作

点项目旁加号打开自己的目录，用“新建 Claude 终端”完成环境内的授权。先让 Claude 读取一个文件或完成小修改，在主机检查结果后再投入正式任务。文件、终端和上传操作见[项目、终端与文件](workbench.md)。
