import React, { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { api, native, nativeAvailable } from "./api";
import { useAccount } from "./account";
import { MacOSLogin } from "./macos-login";
import { DiagnosticSettings } from "./diagnostics.jsx";
import { ScreenSharingChecks } from "./macos-screen-sharing";
import { Modal } from "./modal";
import "./initialization.css";

const steps = [
  { id: "screen", label: "窗口录制", purpose: "让 Cage 在这里显示虚拟 Mac 的设置和授权画面。", instructions: ["如果先出现系统提示，点击 Open System Settings（打开系统设置）。", "在设置画面中，找到 Cage Guest Window，打开它右侧的开关。", "如果提示 Quit & Reopen（退出并重新打开），点击它。画面短暂断开后会重新连接。"] },
  { id: "input", label: "辅助功能", purpose: "让你可以直接在 Cage 中点击虚拟 Mac 的按钮、输入文字。", instructions: ["在下方设置画面中，找到 Cage Guest Window，打开它右侧的开关。", "如果要求管理员认证，按下方的密码指引完成，再打开开关。"] },
  { id: "projects", label: "文件系统扩展", purpose: "让虚拟 Mac 可以读写你允许使用的本机文件夹。", instructions: ["在下方「文件系统扩展」面板中，分别打开 macFUSE 和 macFUSE (local) 两个开关。", "如果要求管理员认证，按下方的密码指引完成。两个开关都需要打开。"] },
  { id: "sharing", label: "屏幕共享", purpose: "让 Cage 连接虚拟 Mac 的桌面，供你在工作台中操作。", instructions: ["在下方「通用 → 共享（Sharing）」页面确认「屏幕共享（Screen Sharing）」已打开，允许安装时创建的账户访问。", "如果仍停在上一项设置，在左上角搜索框输入 Sharing，再点击搜索结果中的 Sharing。确认后点击「已开启，重新检查」，通过后会自动继续。"] },
];

function PermissionInstructions({ step, installing, compact = false }) {
  return <div className="mac-setup-instructions">
    <p>{step.purpose}</p>
    <ol>{(installing ? ["在下方 macFUSE 安装器中依次点击「继续」「安装」，按密码指引完成管理员认证。", "安装完成后关闭安装器。Cage 会自动打开扩展设置，再按提示打开两个开关。"] : step.instructions).map(text => <li key={text}>{text}</li>)}</ol>
    {!compact && step.id !== "sharing" && <p className="mac-setup-retention">完成后会自动检查并进入下一项，无需反复点击按钮。</p>}
  </div>;
}

export function MacOSFirstSetup() {
  const { account, refresh } = useAccount();
  const [permissionPage, setPermissionPage] = useState("screen");
  const [state, setState] = useState(null);
  const [permissions, setPermissions] = useState({});
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [desktopWaiting, setDesktopWaiting] = useState(false);
  const [completionFailed, setCompletionFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [details, setDetails] = useState(false);
  const current = useRef({ account, refresh });
  current.current = { account, refresh };
  const control = useRef({ active: false, inFlight: false, started: false, finished: false, measured: false, waitingSince: 0, requested: "", pending: "" });

  async function request(action) {
    const lifecycle = action === "start" || action === "stop";
    const signal = AbortSignal.timeout(action === "finish" ? 60000 : 30000);
    let result;
    try {
      result = await api(lifecycle ? `/${action}` : "/macos/first-setup", action === "start" ? { guest_system: "macos" } : action === "stop" ? {} : { action }, undefined, {}, { signal });
    } catch (e) {
      if (signal.aborted) throw new Error("等待客机响应超时。请重新检查状态，确认刚才的操作是否已完成后继续。");
      // A finish response can be lost after the server has closed this entry.
      if (e.status === 410) await current.current.refresh();
      throw e;
    }
    if (result.error) throw new Error(result.error);
    return result;
  }

  // Automatic probes, page changes and explicit retries share one operation slot.
  // A failed probe retains the previous display but cannot advance the workflow.
  async function check() {
    const c = control.current;
    if (c.inFlight || !c.active) return;
    c.inFlight = true;
    setBusy(true);
    try {
      const next = await api("/status", undefined, undefined, {}, { signal: AbortSignal.timeout(15000) });
      if (!c.active) return;
      setState(next);
      const credentialsPending = current.current.account.macos_password_pending;
      if ((!next.vm_running || credentialsPending) && !next.job?.running && !next.job?.error && !next.job?.canceled && !c.started) {
        c.started = true;
        setBusy(true);
        try { await request("start"); }
        catch (e) { if (c.active) setError(e.message); }
        return;
      }
      if (!next.ready || next.job?.running || credentialsPending) { setReadError(""); setDesktopWaiting(false); return; }
      let measured;
      try { measured = await request("permissions"); }
      catch (e) {
        // Right after boot the guest is still signing in its ordinary user;
        // its window helper starts with the desktop. That is progress, not a failure.
        c.waitingSince ||= Date.now();
        if (!c.measured && Date.now() - c.waitingSince < 5 * 60 * 1000) { if (c.active) { setReadError(""); setDesktopWaiting(true); } return; }
        if (c.active) setDesktopWaiting(false);
        throw e;
      }
      if (!c.active) return;
      c.measured = true;
      setDesktopWaiting(false);
      setReadError("");
      setPermissions(measured);
      const pending = steps.find(({ id }) => !measured[id]);
      const requestKey = pending?.id === "projects" ? `projects:${Boolean(measured.project_install_required)}` : pending?.id;
      if (pending && c.pending !== pending.id) {
        c.pending = pending.id;
        setPermissionPage(pending.id);
      }
      if (measured.managed_credential && pending && c.requested !== requestKey) {
        c.requested = requestKey;
        setPermissionPage(pending.id);
        setBusy(true);
        try { await request(pending.id); setError(""); }
        catch (e) { if (c.active) setError(e.message); }
      }
      if (!pending && !c.finished) {
        c.finished = true;
        setBusy(true);
        try { await request("finish"); if (c.active) await current.current.refresh(); }
        catch (e) { if (c.active) { setCompletionFailed(true); setError(e.message); } }
      }
    } catch (e) { if (c.active) setReadError(e.name === "TimeoutError" ? "读取客机状态超时。请重新检查状态；已有安装进度会保留。" : e.message); }
    finally { c.inFlight = false; if (c.active) setBusy(false); }
  }

  useEffect(() => {
    const c = control.current;
    c.active = true;
    let timer;
    async function poll() {
      await check();
      if (c.active) timer = setTimeout(poll, 2000);
    }
    poll();
    window.cageWorkbenchAction = async command => {
      if (command === "closeTab") document.dispatchEvent(new Event("cage-close-modal"));
      if (command === "quit") await native("quitNow");
    };
    window.cageEditAction = () => false;
    if (nativeAvailable()) native("workbenchReady").catch(() => {});
    return () => { c.active = false; clearTimeout(timer); delete window.cageWorkbenchAction; delete window.cageEditAction; };
  }, []);

  async function act(action) {
    const c = control.current;
    if (c.inFlight) return;
    c.inFlight = true;
    if (action === "stop") c.started = true;
    if (steps.some(({ id }) => id === action)) { setPermissionPage(action); c.requested = action === "projects" ? `projects:${Boolean(permissions.project_install_required)}` : action; }
    setBusy(true); setError("");
    try {
      await request(action);
      if (action === "finish") { await current.current.refresh(); setCompletionFailed(false); }
    } catch (e) {
      if (action === "finish") setCompletionFailed(true);
      setError(e.message);
    } finally { c.inFlight = false; if (c.active) { setBusy(false); void check(); } }
  }

  const pending = steps.find(({ id }) => !permissions[id]);
  const selected = pending || steps.find(({ id }) => id === permissionPage);
  const projectInstallation = selected.id === "projects" && permissions.project_install_required;
  const selectedHint = <>
    {pending ? <><p className="mac-setup-eyebrow">第 {steps.indexOf(pending) + 1} / {steps.length} 项 · {pending.label} · 在虚拟 Mac 内操作</p><PermissionInstructions step={pending} installing={projectInstallation} compact /></> : <p>系统权限已检查完成，正在保存设置。</p>}
    {pending && <details className="mac-setup-password-help"><summary>出现管理员密码窗口时怎么填？</summary><p>用户名填 <strong>cagesetup</strong>。{permissions.managed_credential ? "先点中密码框，再点击上方「填写授权密码」，最后在系统窗口中确认。" : account.macos_credentials_ready ? "密码填写 Cage 账户密码，再在系统窗口中确认。" : "输入安装时设置的客机管理员密码，再在系统窗口中确认。"}</p></details>}
  </>;
  const running = Boolean(state?.job?.running);
  const canOperate = Boolean(state?.vm_running && !running && !busy);
  const canFinish = Boolean(state?.ready && !account.macos_password_pending && !pending && !readError);
  const progress = !state ? "正在读取安装进度…" : running ? state.job.message || "正在启动和配置虚拟 Mac…" :
    account.macos_password_pending ? "客机密码尚未同步，请重试同步后继续授权。" : !state.vm_running ? "虚拟 Mac 尚未启动，可从已有磁盘继续。" :
    !state.ready ? "虚拟 Mac 已启动，正在等待客机连接。若停在登录画面，请打开客机画面完成登录。" :
    desktopWaiting ? "虚拟 Mac 正在完成首次登录并启动桌面，通常需要 1–3 分钟。桌面就绪后会自动打开第一项授权。" :
    readError ? "暂时无法确认权限状态，已显示的结果供参考。恢复连接后会继续检查。" :
    pending ? `当前需要确认「${pending.label}」。完成后 Cage 会自动检查并继续。` :
    completionFailed ? "四项权限已验证，最后的设置收尾未完成。请重试完成设置。" : "四项权限已验证，正在保存设置；随后继续工作区授权和联网检查。";
  const sharingControls = <>
    <button type="button" disabled={!canOperate} onClick={() => act("sharing")}>{busy ? "正在处理…" : "打开屏幕共享设置"}</button>
    <button type="button" className="primary" disabled={!canOperate} onClick={() => act("confirm-sharing")}>{busy ? "正在检查…" : "已开启，重新检查"}</button>
  </>;
  const controls = !pending ? <button type="button" className="primary" disabled={busy || !completionFailed || !canFinish} onClick={() => act("finish")}>
    {completionFailed ? "重试完成设置" : "正在保存设置…"}
  </button> : pending.id === "sharing" ? sharingControls : <button type="button" className="primary" disabled={!canOperate} onClick={() => act(pending.id)}>
    {busy ? "正在处理…" : projectInstallation ? "打开 macFUSE 安装器" : `打开${pending?.label || selected.label}`}
  </button>;
  const failure = error || readError || (!state?.ready && !running && state?.job?.error) || (!state?.ready && state?.environment_update_error);

  return <main className="initialization"><section className="initialization-content mac-setup-content">
    <div className="initialization-title"><p className="mac-setup-eyebrow">系统已安装 · 接下来开启使用所需的权限</p><h1>完成虚拟 Mac 的系统授权</h1>
      <p>下面四项设置都在虚拟 Mac 内完成。Cage 会自动打开对应页面，你只需按提示开启开关；每项通过后自动继续。</p></div>
    <ol className="mac-setup-checklist" aria-label="系统授权进度">
      {steps.map(({ id, label }, index) => <li key={id} data-complete={Boolean(permissions[id])} aria-current={pending?.id === id ? "step" : undefined}>
        <span className="mac-setup-marker">{permissions[id] ? <Check size={16} aria-hidden="true" /> : index + 1}</span>
        <span>{label}</span><small>{permissions[id] ? "已验证" : pending?.id === id ? "等待确认" : "稍后确认"}</small>
      </li>)}
    </ol>
    <section className="initialization-operation mac-setup-task" aria-label="当前设置步骤">
      <h2>{!state?.ready ? "连接虚拟 Mac" : pending ? `确认${pending.label}` : "完成系统设置"}</h2>
      <p role="status">{busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />} {progress}</p>
      {pending && state?.ready && <><PermissionInstructions step={pending} installing={projectInstallation} />
        <p className="mac-setup-retention">点击「打开客机画面」进入操作。所有设置都在那张画面中完成。</p>
        {pending.id === "projects" && permissions.projects_error && <p>{permissions.projects_error}</p>}
        {pending.id === "sharing" && <ScreenSharingChecks checks={permissions.sharing_checks} summary={permissions.sharing_summary} />}
      </>}
      <div className="initialization-recovery">
        {state && !running && (!state.ready || account.macos_password_pending) && <button className="primary" disabled={busy} onClick={() => act("start")}>{account.macos_password_pending ? "重试同步客机密码" : "继续启动并连接"}</button>}
        {pending && state?.ready && controls}
        {completionFailed && <button className="primary" disabled={busy || !canFinish} onClick={() => act("finish")}>重试完成设置</button>}
        <button disabled={busy || running} onClick={() => void check()}>重新检查状态</button>
      </div>
      {running && <button disabled={busy} onClick={() => act("stop")}>停止当前操作，保留进度</button>}
      {state?.vm_running && <MacOSLogin initialSetup autoOpen={Boolean(permissions.managed_credential)} managedCredential={permissions.managed_credential} disabled={!state.vm_running || running}
        label="打开客机画面" setupActions={controls} setupHint={selectedHint}
        setupStatus={failure || progress} setupError={Boolean(failure)} />}
    </section>
    {failure && <section className="initialization-notice" role="alert"><h2>这一步尚未完成</h2><p>{failure}</p><p>已有安装进度会保留。可以重新打开当前设置页，或重新检查状态后继续。</p></section>}
    <details className="mac-setup-help"><summary>管理员密码与找不到设置页时的帮助</summary>
      <p>系统要求管理员时，用户名填 <strong>cagesetup</strong>，{account.macos_password_pending ? "密码同步完成前可能仍需原客机密码。" : account.macos_credentials_ready ? "密码与 Cage 账户相同。" : "在客机画面中选中密码框，再点击「填写授权密码」。"}你确认授权后继续；此临时管理员在收尾时停用。</p>
      <p>文件系统扩展的手动入口：客机「系统设置 → 通用 → 登录项与扩展 → 按类别 → 文件系统扩展」，同时打开 macFUSE 和 macFUSE (local)。</p>
      <p>屏幕共享的手动入口：客机「系统设置 → 通用 → 共享」，打开「屏幕共享」并允许当前普通客机用户。</p>
      <div className="initialization-recovery">{steps.map(({ id, label }) => <button key={id} disabled={!canOperate} onClick={() => act(id)}>重新打开{label}</button>)}</div>
    </details>
    <p className="mac-setup-retention">系统授权完成后，还会确认共享工作区和网络隔离。全部检查通过后即可进入工作台。</p>
    <div className="initialization-support"><button className="text-button" onClick={() => setDetails(true)}>查看操作详情</button><button className="text-button" onClick={() => setDiagnostics(!diagnostics)}>日志与诊断</button></div>
    {diagnostics && <DiagnosticSettings />}
    {details && <Modal title="系统设置操作详情" onClose={() => setDetails(false)}><div className="modal-body"><p>{progress}</p>{failure && <p role="alert">{failure}</p>}<pre className="job-log">{state?.job?.log || "当前步骤没有额外操作日志。可通过「日志与诊断」导出完整记录。"}</pre></div></Modal>}
  </section></main>;
}
