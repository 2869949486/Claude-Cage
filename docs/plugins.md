# 插件

插件让环境里的 Claude 在你的电脑上多一项能力。一个插件就是一个目录，里面有一份清单和一个程序；程序是标准的 MCP 服务，通过标准输入输出通信。

## 安装

把插件目录放进配置目录的 `plugins/` 下（默认 `~/.claude-cage/plugins/<插件名>/`），并打开主机工具。下次环境启动时加载。

插件以你的用户权限在电脑上运行。每次调用前会弹出确认，显示插件、工具和参数；可以只允许一次，也可以在本次会话内都允许。只安装你信任的插件。

## 清单 `plugin.json`

```json
{
  "name": "clock",
  "version": "0.1.0",
  "description": "Tells the current time on this computer.",
  "platforms": ["darwin", "linux", "windows"],
  "permissions": [],
  "command": ["python3", "server.py"]
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

清单里不能有其他字段。

## 工具的命名和说明

工具的名称和说明会发送给模型，所以只描述工具做什么。名称或说明里出现本产品的名字，或者「虚拟机」「客机」「VM」「guest」之类描述运行环境的词，插件会被拒绝加载。工具名不能与已有工具重复。

## 示例

[`internal/hostbridge/catalog/clock`](../internal/hostbridge/catalog/clock) 是一个完整的插件，只用到 Python 标准库。
