import React, { useEffect, useRef, useState } from "react";
import { Blocks, Check, Copy, RefreshCw, TriangleAlert } from "lucide-react";
import { api, writeClipboard } from "./api";
import "./tailscale.css";
import "./host-plugins.css";

const permissions = { files: "读写文件", commands: "运行命令", screen: "查看屏幕", input: "控制键盘和鼠标", network: "访问网络" };
const builtIn = { commands: { title: "命令", description: "在已打开的项目文件夹中运行命令，较长的命令可在后台运行并稍后读取结果。" } };

export function HostPluginsPanel({ status, onConfirm }) {
  const [view, setView] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const mounted = useRef(true), revision = useRef(0);
  const refresh = async () => {
    const current = ++revision.current;
    try {
      const value = await api("/host-tools");
      if (mounted.current && current === revision.current) { setView(value); setError(""); }
    } catch (e) { if (mounted.current && current === revision.current) setError(e.message); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => { if (!busy) void refresh(); }, 5000);
    return () => { mounted.current = false; revision.current++; clearInterval(timer); };
  }, [busy]);
  const change = async (body) => {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); revision.current++;
    try {
      const value = await api("/host-tools", body);
      if (mounted.current) setView(value);
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const toggle = async () => {
    if (!view.enabled && !await onConfirm({ title: "允许 Claude 使用这台电脑？",
      body: "开启后，环境内的 Claude 可以通过插件在这台电脑上操作，例如在已打开的项目文件夹中运行命令。命令以你的系统账户权限运行，不受环境的隔离保护。每次操作前，系统会弹出确认窗口，由你决定是否允许。",
      confirm: "开启" })) return;
    await change({ enabled: !view.enabled });
  };
  const copy = async () => {
    try { await writeClipboard(view.directory); setNotice("已复制插件文件夹路径"); }
    catch { setNotice("复制失败，请选中文本手动复制。"); }
  };
  if (!view) return <div className="tailscale-panel host-plugins">{error ? <p role="alert" className="notice error">{error}</p> : <p role="status" className="field-help">正在读取插件…</p>}</div>;
  const waiting = view.enabled && !view.running;
  return (
    <div className="tailscale-panel host-plugins">
      <section className={`tailscale-overview ${view.running ? "connected" : ""}`}>
        <div className="tailscale-state">
          <div className="tailscale-network-icon"><Blocks size={22} /></div>
          <div>
            <strong>{!view.available ? "此环境不支持" : view.running ? "已开启" : waiting ? "已开启，等待环境就绪" : "未开启"}</strong>
            <span>插件通过 MCP 把这台电脑的能力提供给环境内的 Claude Code 和 Claude 桌面应用。</span>
          </div>
          {view.available && <label className="host-plugins-switch"><input role="switch" type="checkbox" aria-label="允许 Claude 使用这台电脑" checked={view.enabled} disabled={busy} onChange={toggle} /></label>}
        </div>
        <p className="field-help">每次操作都会先由系统弹窗征求你的同意，你可以只允许一次，或在本次运行期间都允许。此功能仍在试验阶段，默认关闭。</p>
        {waiting && status?.ready && <p className="field-help">启动未完成，请稍候或点击“重新加载”。</p>}
        {waiting && !status?.ready && <p className="field-help">环境启动后自动生效。</p>}
        {error && <p role="alert" className="notice error">{error}</p>}
      </section>
      <section className="tailscale-section">
        <div className="tailscale-section-heading">
          <h3>插件清单<span>{view.plugins.length}</span></h3>
          {view.enabled && <button type="button" disabled={busy || !status?.ready} onClick={() => change({ reload: true })}><RefreshCw size={14} />重新加载</button>}
        </div>
        <div className="tailscale-peers">
          {view.plugins.map(plugin => {
            const known = plugin.built_in ? builtIn[plugin.name] : null;
            const state = plugin.problem ? "无法使用" : !plugin.supported ? "不支持此系统" : plugin.loaded ? "运行中" : view.running ? "未加载" : "未运行";
            return <article className="tailscale-peer" key={plugin.name}>
              <div className="tailscale-peer-row">
                {plugin.problem ? <TriangleAlert size={20} /> : <Blocks size={20} />}
                <div className="tailscale-peer-info">
                  <strong>{known?.title || plugin.name}{plugin.built_in && <span className="tailscale-badge">内置</span>}{plugin.version && <span className="tailscale-badge">{plugin.version}</span>}</strong>
                  <span>{plugin.problem || known?.description || plugin.description || "插件没有提供说明"}</span>
                  {!plugin.problem && <span>权限：{plugin.permissions.length ? plugin.permissions.map(name => permissions[name] || name).join("、") : "未声明任何权限"}</span>}
                  {plugin.tools?.length > 0 && <span>工具：{plugin.tools.map(tool => tool.name).join("、")}</span>}
                </div>
                <span className={`tailscale-presence ${plugin.loaded ? "online" : ""}`}><i />{state}</span>
              </div>
            </article>;
          })}
        </div>
        {view.problems?.length > 0 && <div className="tailscale-health" role="alert"><strong>部分插件未能加载</strong>{view.problems.map(problem => <p key={problem}>{problem}</p>)}</div>}
      </section>
      <section className="tailscale-section">
        <h3>可操作的文件夹</h3>
        {view.folders.length ? view.folders.map(folder => <code className="host-plugins-path" key={folder}>{folder}</code>) : <p className="field-help">还没有打开项目。命令插件只能在已打开的项目文件夹中运行。</p>}
      </section>
      <section className="tailscale-section">
        <h3>安装插件</h3>
        <p className="field-help">把插件文件夹放进下面的位置，然后点击“重新加载”。每个插件是一个带有 plugin.json 的文件夹，写法见仓库中的 docs/plugins.md。只安装你信任的插件：插件以你的系统账户权限运行。</p>
        <div className="tailscale-command"><code>{view.directory}</code><button type="button" className="icon-button" aria-label="复制插件文件夹路径" onClick={copy}><Copy size={15} /></button></div>
        {notice && <p className="tailscale-notice" role="status"><Check size={14} />{notice}</p>}
      </section>
    </div>
  );
}
