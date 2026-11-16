import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Modal } from "./modal";
import { MacOSLogin } from "./macos-login";
import { FolderOpen, LoaderCircle } from "lucide-react";
import "./macos-project-approval.css";

const permissionMessages = {
  project_screen_permission: "无法显示文件夹授权窗口。请在虚拟 Mac 的“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中允许 Cage Guest Window，并按系统提示重新打开助手。",
  accessibility_permission: "无法点击文件夹授权窗口。请在虚拟 Mac 的“系统设置 → 隐私与安全性 → 辅助功能”中允许 Cage Guest Window，然后重试。",
  requires_gui_login: "请先登录并解锁虚拟 Mac 的普通账户，然后重新打开项目。",
  unknown_action: "当前环境组件尚不支持直接确认。请展开下方的 macOS 授权窗口，点击右下角 Use Project，再重新检查。",
  project_button_not_hit: "尚未点中允许按钮。请点击下方「允许使用此文件夹」，或在 macOS 授权窗口中点击右下角 Use Project。",
  project_panel_still_open: "macOS 尚未完成确认。请稍后重试，或展开授权窗口查看系统提示。",
  no_project_panel: "当前未找到这次文件夹授权窗口。若已在 macOS 中允许，请点击重新检查；否则请重新请求授权。",
  window_changed: "授权窗口已变化，正在重新读取。请稍后再点击允许。",
  project_panel_changed: "这次文件夹授权请求已变化，正在重新读取。请确认文件夹后再点击允许。",
  project_window_identity_changed: "显示的授权窗口已被替换，正在重新读取。请看到新画面后再点击允许。",
  project_window_not_frontmost: "文件夹授权窗口未处于客机前台。请关闭遮挡它的窗口，再点击允许。",
  project_window_focus_unavailable: "无法读取文件夹授权窗口的焦点。请在客机中激活授权窗口后重试。",
  project_window_geometry_unavailable: "无法读取文件夹授权窗口的位置和尺寸。请重新打开授权窗口后重试。",
  project_window_geometry_changed: "文件夹授权窗口的位置或尺寸与当前画面不一致。请停止移动或缩放窗口，看到新画面后再点击允许。",
};

function ApprovalFolder({ workspace, initializing }) {
  const name = workspace.split("/").filter(Boolean).at(-1) || workspace;
  return <>
    <p className="macos-approval-intro">让虚拟 Mac 里的终端和编辑器可以打开、保存你的文件。</p>
    <div className="macos-approval-folder"><FolderOpen size={24} aria-hidden="true" /><div><small>本次允许访问的文件夹</small><strong>{name}</strong><span className="macos-approval-path">{workspace}</span></div></div>
    <p>本次仅授权这个文件夹及其内容。其中的修改会同步到本机，请确认这是你准备使用的文件夹。</p>
    <p className="macos-approval-next">{initializing ? "允许后会自动验证文件夹访问并继续联网检查，通过后即可进入工作台。" : "允许并验证通过后，即可在终端和编辑器中使用这个文件夹。"}</p>
  </>;
}

export function InitializationProjectApproval({ workspace, jobRunning, onClose, onApproved = onClose }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const approved = useRef(onApproved);
  approved.current = onApproved;

  useEffect(() => {
    if (jobRunning || pending || error) return;
    let live = true, timer;
    async function open() {
      setRequesting(true);
      try {
        const result = await api("/projects/open", { workspace, add: false, activate: false });
        if (!live) return;
        if (result.approval) setPending({ workspace: result.workspace, grant: result.approval });
        else approved.current();
      } catch (e) {
        if (!live) return;
        if (e.recovery === "project-operation-busy") timer = setTimeout(open, 1200);
        else setError(e.message);
      } finally {
        if (live) setRequesting(false);
      }
    }
    open();
    return () => { live = false; clearTimeout(timer); setRequesting(false); };
  }, [workspace, jobRunning, pending, error]);

  if (pending) return <MacOSProjectApproval initializing pending={pending} onClose={onClose} onCheck={async () => {
    const result = await api("/projects/open", { workspace, add: false, activate: false });
    if (result.approval) setPending({ workspace: result.workspace, grant: result.approval });
    else onApproved();
  }} />;
  return <Modal title="允许使用这个文件夹" onClose={requesting ? undefined : onClose} footer={<>
    <button disabled={requesting} onClick={onClose}>暂不授权</button>
    {error && <button className="primary" onClick={() => setError("")}>重新请求授权</button>}
  </>}>
    <div className="modal-body macos-approval-body"><ApprovalFolder workspace={workspace} initializing />
      {error ? <p role="alert">{error}</p> : <p className="macos-approval-status" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />{jobRunning ? "正在等待当前操作结束，随后会显示授权按钮。暂时无需操作。" : "正在打开文件夹授权，暂时无需操作…"}</p>}
    </div>
  </Modal>;
}

export function MacOSProjectApproval({ pending, onCheck, onClose, onSettings, initializing = false }) {
  const [frame, setFrame] = useState(null),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [ended, setEnded] = useState(false);
  const [maintenance, setMaintenance] = useState("");
  const active = useRef(false),
    inFlight = useRef(null);
  const call = (action, fields = {}) =>
    api("/macos/project-approval", {
      workspace: pending.workspace,
      grant: pending.grant,
      action,
      ...fields,
    });

  useEffect(() => {
    let live = true,
      timer;
    async function poll() {
      if (!active.current) {
        try {
          const request = call("frame");
          inFlight.current = request;
          const result = await request;
          if (live && !active.current) {
            if (result.error === "project_screen_permission") setMaintenance("screen");
            if (result.error === "accessibility_permission") setMaintenance("input");
            const valid = Boolean(
              !result.error &&
              result.image &&
              result.window &&
              result.pid &&
              result.nonce,
            );
            setFrame(valid ? result : null);
            setNotice(
              valid
                ? ""
                : permissionMessages[result.error] || "正在等待 macOS 显示授权窗口。若已在系统窗口中允许，可展开下方窗口并重新检查。",
            );
          }
        } catch (e) {
          if (live && !active.current) {
            setFrame(null);
            setNotice(e.message);
            if (e.recovery === "project-approval-ended") {
              setEnded(true);
              return;
            }
          }
        } finally {
          inFlight.current = null;
        }
      }
      if (live) timer = setTimeout(poll, 650);
    }
    setFrame(null);
    setEnded(false);
    setMaintenance("");
    setNotice("");
    setActionError("");
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [pending.workspace, pending.grant]);

  async function act(fn) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setActionError("");
    try {
      await inFlight.current?.catch(() => {});
      await fn();
    } catch (e) {
      setFrame(null);
      if (e.recovery === "project-approval-ended") setEnded(true);
      setActionError(e.message);
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  const cancel = () =>
    act(async () => {
      try {
        await call("cancel");
      } catch (error) {
        if (error.recovery !== "project-approval-ended") throw error;
      }
      onClose();
    });
  const click = (event) => {
    if (!frame) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width,
      y = (event.clientY - rect.top) / rect.height;
    if (!(x >= 0 && x < 1 && y >= 0 && y < 1)) return;
    void act(async () => {
      const result = await call("click", {
        window: frame.window,
        pid: frame.pid,
        nonce: frame.nonce,
        x,
        y,
      });
      setFrame(null);
      if (result.error === "accessibility_permission") setMaintenance("input");
      if (result.error) throw new Error(permissionMessages[result.error] || "客机授权窗口已变化，请等待新画面。");
      await onCheck();
    });
  };
  const confirm = () => act(async () => {
    if (!frame || ended) return;
    const result = await call("confirm", { window: frame.window, pid: frame.pid, nonce: frame.nonce });
    if (result.error === "accessibility_permission") setMaintenance("input");
    if (result.error) throw new Error(permissionMessages[result.error] || "暂时无法确认授权，请展开 macOS 授权窗口查看提示后重试。");
    setFrame(null);
    await onCheck();
  });
  return (
    <Modal
      title="允许使用这个文件夹"
      onClose={busy ? undefined : cancel}
      footer={
        <>
          <button disabled={busy} onClick={cancel}>
            暂不授权
          </button>
          <button className="primary" disabled={busy || (!ended && !frame)} onClick={ended ? () => act(onCheck) : confirm}>
            {busy ? "正在确认…" : ended ? "重新请求授权" : "允许使用此文件夹"}
          </button>
        </>
      }
    >
      <div className="modal-body macos-approval-body">
      <ApprovalFolder workspace={pending.workspace} initializing={initializing} />
      {notice && <p className="macos-approval-status" role="status">{notice}</p>}
      {!frame && !notice && !ended && <p className="macos-approval-status" role="status"><LoaderCircle size={16} className="spin" aria-hidden="true" />正在读取 macOS 授权窗口…</p>}
      {maintenance && !ended && <MacOSLogin maintenance={maintenance} onSettings={onSettings} onSessionClosed={() => void act(onCheck)} />}
      {actionError && <p role="alert">{actionError}</p>}
      <details className="macos-approval-help"><summary>查看 macOS 授权窗口 / 已允许但未继续？</summary>
      <p>窗口已定位到上面的文件夹，无需另选目录。也可以直接点击画面右下角的 <strong>Use Project（使用项目）</strong>。列表为空也可以允许。</p>
      {frame && (
        <img
          src={"data:image/png;base64," + frame.image}
          alt="虚拟 Mac 的当前项目授权窗口"
          onClick={click}
          className="macos-approval-frame"
          draggable={false}
        />
      )}
      <button disabled={busy} onClick={() => act(onCheck)}>我已允许，重新检查</button>
      </details>
      <p className="macos-approval-retention">暂不授权会返回上一步，已有安装进度和文件会保留。</p>
      </div>
    </Modal>
  );
}
