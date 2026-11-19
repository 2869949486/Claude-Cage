# 插件

插件让环境里的 Claude 在你的电脑上多一项能力。一个插件就是一个目录，里面有一份清单和一个程序；程序是标准的 MCP 服务，通过标准输入输出通信。

## 安装

在侧栏打开「MCP 插件」，先打开总开关，再进入「插件市场」选择插件安装。市场的内容来自 [cage-plugins](https://github.com/Lee-xeo/cage-plugins) 仓库：应用读取其中的索引，下载压缩包并核对 SHA-256 后安装。读取和下载走电脑自己的网络，遵循系统代理设置。

也可以手动安装：把插件目录放进配置目录的 `plugins/` 下（默认 `~/.claude-cage/plugins/<插件名>/`），然后在插件清单页点击「重新加载」。

卸载或更新时，原来的插件目录不会被删除，而是移到配置目录的 `plugins-removed/` 下。

每个插件可以单独停用，包括内置的命令插件。停用的插件不会启动，它的工具也不再提供给 Claude；文件保留在原处，随时可以重新启用。

插件程序启动时使用与终端相同的 `PATH`，因此清单里可以直接写 `python3`、`node` 等命令，不必写绝对路径。

插件以你的用户权限在电脑上运行。调用前会弹出确认，显示插件、工具和参数，你可以拒绝、只允许这一次，或选择「始终允许」。只安装你信任的插件。

## 授权

是否放行由你决定，决定可以被记住：

- 「始终允许」按插件记录；内置的命令插件按项目记录。记住之后，同一插件（或同一项目里的命令）不再询问，应用重启后依然有效。
- 授权可以在插件页查看和撤销，撤销后立即恢复逐次询问。
- 插件更新后如果声明了你当初没有同意过的权限，授权自动失效，会重新询问。卸载插件时授权一并清除。
- Windows 的确认窗口只有允许和拒绝两个按钮，「始终允许」在插件页里设置。

授权记录保存在配置目录的 `host-grants.json`。

## 清单 `plugin.json`

```json
{
  "name": "clock",
  "version": "0.1.0",
  "description": "Tells the current time on this computer.",
  "platforms": ["darwin", "linux", "windows"],
  "permissions": [],
  "command": ["python3", "server.py"],
  "icon": "icon.svg"
}
```

| 字段 | 说明 |
| --- | --- |
| `name` | 小写字母、数字和连字符，必须与目录名相同 |
| `version` | 版本号 |
| `description` | 一句话说明 |
| `platforms` | 支持的系统：`darwin`、`linux`、`windows`。省略表示都支持 |
| `permissions` | 插件在电脑上会做的事，必须写明，没有就写空列表。可选值：`files`、`commands`、`screen`、`input`、`network` |
| `command` | 程序和参数。相对路径从插件目录算起 |
| `icon` | 插件目录内的一张 PNG 或 SVG 图片，显示在插件名称旁，不超过 256 KB。可省略 |

清单里不能有其他字段。

## 工具的命名和说明

工具的名称和说明会发送给模型，所以只描述工具做什么。名称或说明里出现本产品的名字，或者「虚拟机」「客机」「VM」「guest」之类描述运行环境的词，插件会被拒绝加载。工具名不能与已有工具重复。

## 示例

[`internal/hostbridge/catalog/clock`](../internal/hostbridge/catalog/clock) 是一个完整的插件，只用到 Python 标准库。向市场提交插件的方法见 [cage-plugins](https://github.com/Lee-xeo/cage-plugins)。
