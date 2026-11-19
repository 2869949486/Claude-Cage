import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Blocks, Check, ChevronDown, ChevronRight, Copy, Download, RefreshCw, Store, Trash2, TriangleAlert } from "lucide-react";
import { api, writeClipboard } from "./api";
import "./tailscale.css";
import "./host-plugins.css";

const permissions = { files: "读写文件", commands: "运行命令", screen: "查看屏幕", input: "控制键盘和鼠标", network: "访问网络" };
const builtIn = { commands: { title: "命令", description: "在已打开的项目文件夹中运行命令，较长的命令可在后台运行并稍后读取结果。" } };
const toolNotes = { run_command: "在项目文件夹中运行一条命令", command_job: "读取或停止后台运行的命令" };

export const pluginTitle = plugin => plugin.built_in && builtIn[plugin.name]?.title || plugin.name;
const pluginText = plugin => plugin.problem || plugin.built_in && builtIn[plugin.name]?.description || plugin.description || "插件没有提供说明";
const pluginState = (plugin, running) => plugin.problem ? "无法使用" : !plugin.supported ? "不支持此系统" : plugin.loaded ? "运行中" : running ? "未加载" : "未运行";
const permissionText = list => list?.length ? list.map(name => permissions[name] || name).join("、") : "未声明任何权限";

// useHostPlugins keeps the plugin list current while something shows it.
export function useHostPlugins(active) {
  const [view, setView] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const mounted = useRef(true), revision = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const value = await api("/host-tools");
      if (mounted.current && current === revision.current) { setView(value); setError(""); }
    } catch (e) { if (mounted.current && current === revision.current) setError(e.message); }
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => { if (!busy) void refresh(); }, 5000);
    return () => { revision.current++; clearInterval(timer); };
  }, [active, busy, refresh]);
  const change = useCallback(async (body) => {
    setBusy(true); setError(""); revision.current++;
    try {
      const value = await api("/host-tools", body);
      if (mounted.current) setView(value);
      return true;
    } catch (e) { if (mounted.current) setError(e.message); return false; }
    finally { if (mounted.current) setBusy(false); }
  }, []);
  return { view, error, busy, change };
}

// HostPluginsNav is the sidebar section: the installed plugins and the way
// into the marketplace. What is chosen here opens in the workspace.
export function HostPluginsNav({ model, expanded, page, onToggle, onPage }) {
  const plugins = model.view?.plugins || [];
  return (
    <div className="host-plugins-nav">
      <button className={`sidebar-link ${page?.kind === "overview" ? "selected" : ""}`} aria-expanded={expanded} aria-label="MCP 插件" onClick={onToggle}>
        <Blocks size={17} />MCP 插件{" "}{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && <div className="host-plugins-list">
        {plugins.map(plugin => <button key={plugin.name} className={`sidebar-link ${page?.kind === "plugin" && page.name === plugin.name ? "selected" : ""}`}
          title={`${pluginTitle(plugin)} · ${pluginState(plugin, model.view.running)}`} onClick={() => onPage({ kind: "plugin", name: plugin.name })}>
          <i className={`host-plugins-dot ${plugin.loaded ? "online" : plugin.problem ? "problem" : ""}`} /><span>{pluginTitle(plugin)}</span>
        </button>)}
        {!model.view && <span className="host-plugins-hint">{model.error || "正在读取…"}</span>}
        <button className={`sidebar-link ${page?.kind === "market" ? "selected" : ""}`} onClick={() => onPage({ kind: "market" })}><Store size={15} /><span>插件市场</span></button>
      </div>}
    </div>
  );
}

function Overview({ model, status, onConfirm, onPage }) {
  const { view, busy, change } = model;
  const [notice, setNotice] = useState("");
  const waiting = view.enabled && !view.running;
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
  return <>
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
      {waiting && <p className="field-help">{status?.ready ? "启动未完成，请稍候或点击“重新加载”。" : "环境启动后自动生效。"}</p>}
    </section>
    <section className="tailscale-section">
      <div className="tailscale-section-heading">
        <h3>已安装<span>{view.plugins.length}</span></h3>
        <div className="host-plugins-actions">
          {view.enabled && <button type="button" disabled={busy || !status?.ready} onClick={() => change({ reload: true })}><RefreshCw size={14} />重新加载</button>}
          <button type="button" onClick={() => onPage({ kind: "market" })}><Store size={14} />插件市场</button>
        </div>
      </div>
      <div className="tailscale-peers">
        {view.plugins.map(plugin => <article className="tailscale-peer" key={plugin.name}>
          <button type="button" className="tailscale-peer-row host-plugins-row" onClick={() => onPage({ kind: "plugin", name: plugin.name })}>
            {plugin.problem ? <TriangleAlert size={20} /> : <Blocks size={20} />}
            <div className="tailscale-peer-info">
              <strong>{pluginTitle(plugin)}{plugin.built_in && <span className="tailscale-badge">内置</span>}{plugin.version && <span className="tailscale-badge">{plugin.version}</span>}</strong>
              <span>{pluginText(plugin)}</span>
            </div>
            <span className={`tailscale-presence ${plugin.loaded ? "online" : ""}`}><i />{pluginState(plugin, view.running)}</span>
          </button>
        </article>)}
      </div>
      {view.problems?.length > 0 && <div className="tailscale-health" role="alert"><strong>部分插件未能加载</strong>{view.problems.map(problem => <p key={problem}>{problem}</p>)}</div>}
    </section>
    <section className="tailscale-section">
      <h3>可操作的文件夹</h3>
      {view.folders.length ? view.folders.map(folder => <code className="host-plugins-path" key={folder}>{folder}</code>) : <p className="field-help">还没有打开项目。命令插件只能在已打开的项目文件夹中运行。</p>}
    </section>
    <section className="tailscale-section">
      <h3>手动安装</h3>
      <p className="field-help">把插件文件夹放进下面的位置，然后点击“重新加载”。每个插件是一个带有 plugin.json 的文件夹。只安装你信任的插件：插件以你的系统账户权限运行。</p>
      <div className="tailscale-command"><code>{view.directory}</code><button type="button" className="icon-button" aria-label="复制插件文件夹路径" onClick={copy}><Copy size={15} /></button></div>
      {notice && <p className="tailscale-notice" role="status"><Check size={14} />{notice}</p>}
    </section>
  </>;
}

function Detail({ model, name, onConfirm, onPage }) {
  const { view, busy, change } = model;
  const plugin = view.plugins.find(item => item.name === name);
  if (!plugin) return <section className="tailscale-empty"><strong>这个插件已不在清单中</strong><button type="button" onClick={() => onPage({ kind: "overview" })}>返回插件清单</button></section>;
  const remove = async () => {
    if (!await onConfirm({ title: `卸载「${pluginTitle(plugin)}」？`, body: "插件会停止运行。它的文件夹不会被删除，而是移到数据目录的 plugins-removed 中保留。", confirm: "卸载" })) return;
    if (await change({ remove: plugin.name })) onPage({ kind: "overview" });
  };
  return <>
    <section className={`tailscale-overview ${plugin.loaded ? "connected" : ""}`}>
      <div className="tailscale-state">
        <div className="tailscale-network-icon">{plugin.problem ? <TriangleAlert size={22} /> : <Blocks size={22} />}</div>
        <div>
          <strong>{pluginTitle(plugin)}{plugin.built_in && <span className="tailscale-badge">内置</span>}{plugin.version && <span className="tailscale-badge">{plugin.version}</span>}</strong>
          <span>{pluginText(plugin)}</span>
        </div>
        <span className={`tailscale-presence ${plugin.loaded ? "online" : ""}`}><i />{pluginState(plugin, view.running)}</span>
      </div>
      {!view.enabled && <p className="field-help">主机工具未开启，插件不会运行。可在插件清单页开启。</p>}
      {!plugin.built_in && <div className="tailscale-actions"><button type="button" disabled={busy} onClick={remove}><Trash2 size={14} />卸载</button></div>}
    </section>
    {!plugin.problem && <section className="tailscale-section">
      <h3>权限</h3>
      <p className="field-help">{permissionText(plugin.permissions)}。权限由插件自行声明，供你在安装前判断；每次调用仍需你在系统弹窗中同意。</p>
    </section>}
    <section className="tailscale-section">
      <h3>工具<span>{plugin.tools?.length || 0}</span></h3>
      {plugin.tools?.length ? <div className="tailscale-peers">{plugin.tools.map(tool => <article className="tailscale-peer" key={tool.name}>
        <div className="tailscale-peer-info"><strong><code>{tool.name}</code></strong><span>{toolNotes[tool.name] || tool.description || "没有说明"}</span></div>
      </article>)}</div> : <p className="field-help">{plugin.problem ? "插件无法加载，没有可用的工具。" : "插件运行后在这里列出它提供的工具。"}</p>}
    </section>
    {!plugin.built_in && <section className="tailscale-section">
      <h3>位置</h3>
      <code className="host-plugins-path">{view.directory}/{plugin.name}</code>
    </section>}
  </>;
}

function Market({ model, onPage }) {
  const { view, busy, change } = model;
  return <>
    <section className="tailscale-overview">
      <p className="field-help">这里列出随应用附带的插件。社区插件索引尚未开放；在此之前，可以把社区插件的文件夹手动放进插件目录。只安装你信任的插件。</p>
    </section>
    <section className="tailscale-section">
      <h3>可安装<span>{view.catalog.length}</span></h3>
      <div className="tailscale-peers">
        {view.catalog.map(item => <article className="tailscale-peer" key={item.name}>
          <div className="tailscale-peer-row">
            <Blocks size={20} />
            <div className="tailscale-peer-info">
              <strong>{item.name}<span className="tailscale-badge">{item.version}</span></strong>
              <span>{item.description || "插件没有提供说明"}</span>
              <span>权限：{permissionText(item.permissions)}</span>
            </div>
            {item.installed ? <button type="button" onClick={() => onPage({ kind: "plugin", name: item.name })}>已安装</button>
              : <button type="button" className="primary" disabled={busy || !item.supported} onClick={() => change({ install: item.name })}><Download size={14} />{item.supported ? "安装" : "不支持此系统"}</button>}
          </div>
        </article>)}
        {!view.catalog.length && <div className="tailscale-empty"><strong>暂无可安装的插件</strong></div>}
      </div>
    </section>
  </>;
}

// HostPluginsPanel shows, in the workspace, what the sidebar section chose.
export function HostPluginsPanel({ model, page, status, onConfirm, onPage }) {
  const { view, error } = model;
  if (!view) return <div className="tailscale-panel host-plugins">{error ? <p role="alert" className="error-message">{error}</p> : <p role="status" className="field-help">正在读取插件…</p>}</div>;
  return (
    <div className="tailscale-panel host-plugins">
      {page.kind !== "overview" && <button type="button" className="host-plugins-back" onClick={() => onPage({ kind: "overview" })}><ArrowLeft size={14} />插件清单</button>}
      {error && <p role="alert" className="error-message">{error}</p>}
      {page.kind === "plugin" ? <Detail model={model} name={page.name} onConfirm={onConfirm} onPage={onPage} />
        : page.kind === "market" ? <Market model={model} onPage={onPage} />
        : <Overview model={model} status={status} onConfirm={onConfirm} onPage={onPage} />}
    </div>
  );
}
