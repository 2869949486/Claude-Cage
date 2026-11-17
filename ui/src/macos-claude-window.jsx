import React, { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { LoaderCircle, Monitor } from "lucide-react";
import { DesktopToolbar, useDesktopZoom } from "./claude-desktop";
import { MacOSLogin } from "./macos-login";
import { api, native, nativeAvailable } from "./api";
import { BrowserFavorites } from "./browser-favorites";
import { BrowserUploads } from "./browser-uploads";
import { sendFiles } from "./file-transfer";
import { prepareClipboardPaste, sendImage } from "./image-transfer";
import { installRemoteInput } from "./remote-input";
import { createMacWindowInput } from "./macos-window-input.mjs";
import { copyGuestText } from "./shared-clipboard.mjs";
import { useWindowVisibility } from "./window-visibility";
import { createMacWindowConnection } from "./macos-window-connection.mjs";
import { createMacFrameConnection } from "./macos-frame-connection.mjs";
import "./macos-claude-window.css";

const messages = {
  requires_gui_login: "请先登录并解锁虚拟 Mac 的图形账户。",
  screen_recording_permission: "请在虚拟 Mac 的系统授权中，允许 Cage Guest Window 录制屏幕。",
  accessibility_permission: "要操作窗口，请允许虚拟 Mac 中的 Cage Guest Window 使用辅助功能。",
  not_running: "请打开虚拟 Mac 中的应用。",
  no_visible_window: "应用尚未显示窗口，请重新打开应用。",
  identity_error: "虚拟 Mac 中的应用未通过签名检查。",
  window_changed: "活动窗口已变化，请在新画面中重试。",
  unknown_action: "客机窗口输入组件需要更新，请在环境设置中更新组件后重试。",
  input_connection_required: "窗口输入需要重新连接，请恢复画面后重试。",
  input_owned_by_another_view: "另一个连接正在操作此窗口，请等待它释放按键或拖动。",
};

async function windowRequest(base, action, fields = {}, connection) {
  const result = connection ? await connection.request(action, fields) : await api(base + "/window", { action, ...fields });
  if (result.error) {
    const error = new Error(messages[result.error] || "未能读取或操作虚拟 Mac 中的应用窗口。");
    error.code = result.error;
    throw error;
  }
  return result;
}

// Fixed-size native sign-in sheets stay at their real text size. Extend a
// uniform window background across the pane without scaling those pixels.
function matchWindowBackground(img, pane, canvasRef) {
  if (!pane) return;
  if (img.clientWidth >= pane.clientWidth - 1 && img.clientHeight >= pane.clientHeight - 1) return;
  if (!canvasRef.current) {
    canvasRef.current = document.createElement("canvas");
    canvasRef.current.width = 4;
    canvasRef.current.height = 1;
  }
  const canvas = canvasRef.current;
  const ctx = canvas.getContext("2d", {willReadFrequently:true});
  if (!ctx) return;
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (w < 16 || h < 16) return;
  [[8,8],[w-9,8],[8,h-9],[w-9,h-9]].forEach(([x,y],i) =>
    ctx.drawImage(img,x,y,1,1,i,0,1,1));
  const pixels = ctx.getImageData(0,0,4,1).data;
  const uniform = pixels.every((value, index) => Math.abs(value - pixels[index % 4]) <= 4);
  pane.style.backgroundColor = uniform && pixels[3] === 255 ? `rgb(${pixels[0]}, ${pixels[1]}, ${pixels[2]})` : "";
}

// Electron may create a completely blank window before its renderer is ready.
// Check only initial Claude frames, locally; Chrome can legitimately show a
// blank page, and later application frames must remain under the user's control.
function hasWindowContent(img, canvasRef) {
  const canvas = canvasRef.current ??= document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently:true });
  if (!ctx) return true;
  ctx.drawImage(img, 0, 0, 32, 32);
  const pixels = ctx.getImageData(0, 0, 32, 32).data;
  return pixels.some((value, i) => i % 4 !== 3 && Math.abs(value - pixels[i % 4]) > 12);
}

export function MacOSAppWindow({ browser = false, onOpenPage, visible, keyboard = "mac", remoteRef, sidebarCollapsed, onExpand, onConfirm, uploads = [], onStatus = () => {}, onFallback = () => {} }) {
  const appName = browser ? "Google Chrome" : "Claude Desktop";
  const base = browser ? "/macos-browser" : "/macos/claude";
  const windowVisible = useWindowVisibility();
  const screenVisible = visible && windowVisible;
  const connection = useRef(null);
  const [inputChannel, setInputChannel] = useState(null);
  const frameConnection = useRef(null);
  const request = (action, fields) => windowRequest(base, action, fields, connection.current);
  const [zoom, setZoom] = useDesktopZoom();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [transferring, setTransferring] = useState(false);
  const [revision, refresh] = useState(0);
  const [image, setImage] = useState(null);
  const [phase, setPhase] = useState("connecting");
  const [slow, setSlow] = useState(false);
  const [waitingSince, setWaitingSince] = useState(Date.now);
  const waiting = useRef(waitingSince);
  const decoded = useRef(false);
  const stopped = useRef(false);
  function beginWaiting(nextPhase = "connecting") {
    waiting.current = Date.now();
    setWaitingSince(waiting.current);
    decoded.current = false;
    frame.current = null;
    setImage(null);
    setSlow(false);
    setPhase(nextPhase);
    setError("");
  }
  function windowFailure(reason, message) {
    if (stopped.current) { setPhase("stopped"); return; }
    const transient = ["not_running", "no_visible_window", "window_changed"].includes(reason);
    if (decoded.current && transient) { beginWaiting("waiting-window"); return; }
    decoded.current = false;
    // LaunchServices can finish before Electron creates its first window.
    // Keep the same bounded wait across frame reconnects instead of flashing
    // a retry error every time the guest reports this intermediate state.
    if (transient && waiting.current !== null && Date.now() - waiting.current < 60000) {
      setPhase("waiting-window");
      return;
    }
    waiting.current = null;
    setWaitingSince(null);
    setPhase("failed");
    setError(message);
  }
  useEffect(() => {
    if (!screenVisible || waitingSince === null) return;
    const slowTimer = setTimeout(() => setSlow(true), Math.max(0, waitingSince + 10000 - Date.now()));
    const timeout = setTimeout(() => {
      if (waiting.current !== waitingSince) return;
      waiting.current = null;
      setWaitingSince(null);
      setPhase("failed");
      setError(`${appName} 的窗口画面尚未就绪。可以重新连接；若仍无画面，请查看客机登录界面。`);
    }, Math.max(0, waitingSince + 60000 - Date.now()));
    return () => { clearTimeout(slowTimer); clearTimeout(timeout); };
  }, [screenVisible, waitingSince, appName]);
  const frame = useRef(null);
  const surface = useRef(null);
  const controls = useRef(null);
  const current = useRef(null);
  current.current = { screenVisible, keyboard, input: state?.input, onStatus, onFallback };
  const pane = useRef(null);
  const backgroundSample = useRef(null);
  const startupSample = useRef(null);
  const viewport = useRef(null);
  useLayoutEffect(() => {
    const element = pane.current;
    if (!visible || !element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      viewport.current = width > 0 && height > 0 ? {
        width: Math.min(2560, Math.max(320, Math.round(width / zoom))),
        height: Math.min(1600, Math.max(240, Math.round(height / zoom))),
      } : null;
      frameConnection.current?.resize(viewport.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => { observer.disconnect(); viewport.current = null; };
  }, [visible, zoom]);
  // A decoded video frame waits here until the canvas for its window exists.
  const pendingVideo = useRef(null);
  // One element serves a window through its size changes, so resizing does
  // not replace the picture or the input attached to it.
  const videoKey = value => `${value.pid}-${value.window}`;
  function dropVideo() {
    pendingVideo.current?.video.close();
    pendingVideo.current = null;
  }
  function paintVideo() {
    const next = pendingVideo.current, canvas = surface.current;
    if (!next || !(canvas instanceof HTMLCanvasElement) || canvas.dataset.frame !== videoKey(next)) return;
    pendingVideo.current = null;
    try {
      // The guest sends the whole window; the title bar rows are left out here.
      const top = Math.max(0, next.videoCropTop || 0);
      const width = next.video.displayWidth, height = next.video.displayHeight - top;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context || width < 1 || height < 1) throw new Error();
      const resized = canvas.width !== width || canvas.height !== height;
      if (resized) { canvas.width = width; canvas.height = height; }
      // The window's transparent corners arrive black. Fill them with the
      // window's own edge colour, as the still-image path does.
      const corner = Math.min(96, next.videoCorner || 0);
      context.save();
      if (corner > 0 && context.roundRect) {
        context.fillStyle = next.videoEdge || "#000";
        context.fillRect(0, 0, width, height);
        context.beginPath();
        context.roundRect(0, 0, width, height, top > 0 ? [0, 0, corner, corner] : corner);
        context.clip();
      }
      context.drawImage(next.video, 0, top, width, height, 0, 0, width, height);
      context.restore();
      next.video.close();
      const contentWidth = next.contentWidth || width, contentHeight = next.contentHeight || height;
      canvas.style.setProperty("--frame-width", contentWidth + "px");
      canvas.style.setProperty("--frame-aspect", contentWidth / contentHeight);
      frame.current = { window: next.window, pid: next.pid, geometry: next.geometry, surface: browser ? "browser" : undefined };
      if (resized) matchWindowBackground(canvas, pane.current, backgroundSample);
      if (!decoded.current) {
        decoded.current = true;
        waiting.current = null;
        setWaitingSince(null);
        setPhase("ready");
        setError("");
      }
      next.acknowledge?.();
    } catch {
      try { next.video.close(); } catch { /* already closed */ }
      frameConnection.current?.close(); frameConnection.current = null; frame.current = null;
      setImage(null); windowFailure("decode_failed", "窗口画面无法解码，请重新连接。");
    }
  }
  useLayoutEffect(paintVideo, [image]);
  const picker = useRef(null);
  const pickerTarget = useRef(null);
  const generation = useRef(0);
  const launched = useRef(false);

  useEffect(() => {
    if (!screenVisible) return;
    if (browser) launched.current = false;
    const epoch = ++generation.current;
    let timer;
    let current, nextStatus = 0, after = "", captureSize = "", checkFrame = true;
    const live = () => generation.current === epoch;
    function receiveFrame(next) {
      if (!live() || stopped.current) { next.video?.close(); return; }
      if (frame.current?.window !== next.window || frame.current?.pid !== next.pid || frame.current?.geometry !== next.geometry) frame.current = null;
      if (next.video) {
        dropVideo();
        pendingVideo.current = next;
        // Later frames of the same window are drawn without another render.
        setImage(previous => previous?.video && previous.window === next.window && previous.pid === next.pid && previous.geometry === next.geometry
          ? previous : { video: true, window: next.window, pid: next.pid, geometry: next.geometry });
        setError("");
        paintVideo();
        return;
      }
      dropVideo();
      setImage({
        src: next.src || `data:${next.mime === "image/jpeg" ? "image/jpeg" : "image/png"};base64,${next.image}`,
        window: next.window, pid: next.pid,
        geometry: next.geometry, width: next.contentWidth, height: next.contentHeight,
        acknowledge: next.acknowledge,
      });
    }
    async function poll() {
      let delay = 2200;
      try {
        if (!current || Date.now() >= nextStatus) {
          current = await request("status");
          if (browser && current.surface !== "browser") throw new Error("请更新 macOS 环境组件以显示 Chrome 窗口。");
          checkFrame = true;
          nextStatus = Date.now() + 2200;
          if (live() && current.persistent && !connection.current) {
            connection.current = createMacWindowConnection(base);
            setInputChannel(connection.current);
          }
        }
        if (!live()) return;
        setState(current);
        // Opening this tab focuses the signed guest application. A background
        // Electron window can still be captured but cannot receive targeted input.
        if (current.installed && !launched.current) {
          launched.current = true;
          if (waiting.current !== null) setPhase("starting");
          await request("launch");
          if (!live()) return;
          if (waiting.current !== null) setPhase("waiting-window");
          nextStatus = 0;
          delay = 100;
          return;
        }
        if (current.running && current.screen) {
          if (current.push_frames && viewport.current) {
            if (!frameConnection.current) {
              frameConnection.current = createMacFrameConnection(receiveFrame, reason => {
                if (!live()) return;
                frameConnection.current = null;
                nextStatus = 0;
                dropVideo();
                // The next connection asks for still images; keep the last picture meanwhile.
                if (reason === "video_fallback") return;
                frame.current = null;
                setImage(null);
                windowFailure(reason, messages[reason] || "未能读取虚拟 Mac 的窗口画面，请重新连接。");
              }, base);
            }
            frameConnection.current.resize(viewport.current);
            return;
          }
          const nextSize = JSON.stringify(viewport.current);
          if (nextSize !== captureSize) { after = ""; captureSize = nextSize; }
          const next = await request("frame", viewport.current ? {
            after, refresh: checkFrame,
            ...viewport.current, scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
          } : {});
          if (!live()) return;
          checkFrame = false;
          delay = current.persistent ? 50 : 350;
          if (next.unchanged) return;
          after = next.sequence || "";
          receiveFrame(next);
        } else {
          const closed = !current.running && decoded.current;
          frameConnection.current?.close(); frameConnection.current = null; frame.current = null; setImage(null); decoded.current = false;
          if (!current.installed || !current.screen || stopped.current || closed) {
            waiting.current = null; setWaitingSince(null);
            setPhase(!current.installed ? "uninstalled" : stopped.current || closed ? "stopped" : "permission");
          }
        }
      } catch (e) {
        if (!live()) return;
        connection.current?.close(); connection.current = null;
        setInputChannel(null);
        frameConnection.current?.close(); frameConnection.current = null;
        current = null; after = "";
        if (live()) { frame.current = null; setImage(null); windowFailure(e.code, e.message); }
      } finally { if (live()) timer = setTimeout(poll, delay); }
    }
    poll();
    return () => {
      generation.current++; clearTimeout(timer); frame.current = null;
      dropVideo();
      connection.current?.close(); connection.current = null;
      setInputChannel(null);
      frameConnection.current?.close(); frameConnection.current = null;
    };
  }, [screenVisible, revision, base]);

  async function action(name) {
    try {
      if (name === "stop") {
        stopped.current = true; launched.current = true;
        waiting.current = null; setWaitingSince(null); setPhase("stopping");
        frameConnection.current?.close(); frameConnection.current = null;
        frame.current = null; setImage(null); decoded.current = false;
      } else if (name === "launch") {
        stopped.current = false; launched.current = true;
        beginWaiting("starting");
      }
      await request(name);
      if (name === "launch" && waiting.current !== null) setPhase("waiting-window");
      setError(""); refresh((n) => n + 1);
    }
    catch (e) { stopped.current = false; windowFailure(e.code, e.message); }
  }
  useImperativeHandle(remoteRef, () => ({
    focus: () => controls.current?.transport.focus(),
    closeNativeTab: () => controls.current?.transport.runKeyAction(async send => {
      for (const [symbol, code, down] of [[0xffeb, "MetaLeft", true], [119, "KeyW", true], [119, "KeyW", false], [0xffeb, "MetaLeft", false]]) {
        await send(symbol, code, down);
      }
    }).catch(e => setError(e.message)),
    edit: command => controls.current?.input.focused() ? controls.current.input.edit(command) : false,
    copy: () => controls.current?.input.copy(),
    paste: () => controls.current?.input.readAndPaste(),
    pasteText: text => controls.current?.input.paste(text),
    transfer: () => onFallback("", "可在此使用本机复制、粘贴。"),
  }));

  useEffect(() => {
    if (!screenVisible || !state?.input || !surface.current || !pane.current || (state.persistent && !inputChannel)) return;
    const inputRequest = (action, fields) => windowRequest(base, action, fields, inputChannel);
    const transport = createMacWindowInput({
      element: surface.current,
      frame: () => frame.current,
      active: () => Boolean(current.current.screenVisible && current.current.input && frame.current),
      request: inputRequest,
      onError: setError,
    });
    const preparePaste = () => {
      const lease = { target: transport.target(), epoch: generation.current, transport };
      return Object.assign(prepareClipboardPaste("desktop", "", { windowTarget: lease.target, valid: () => transport.valid(lease.target) }), { lease });
    };
    const input = installRemoteInput(transport, pane.current, {
      mode: () => current.current.keyboard,
      guestPlatform: () => "darwin",
      systemClipboard: () => true,
      copyText: (sendCopy, valid) => copyGuestText({ request: value => api("/clipboard/copy", value), sendCopy, valid }),
      surface: () => surface.current,
      inputLabel: "向 " + appName + " 输入",
      tabId: () => frame.current ? `${frame.current.pid}:${frame.current.window}:${frame.current.geometry}` : "",
      isActive: () => Boolean(current.current.screenVisible && current.current.input && frame.current),
      onStatus: text => current.current.onStatus(text),
      onFallback: (...values) => current.current.onFallback(...values),
      insertText: text => transport.send("text", { text }),
      caretRect: session => inputRequest("ime", { ...frame.current, mode: "status", session }).catch(error => {
        if (error.code === "unknown_action") setError(error.message);
        return { available: false };
      }),
      insertComposition: (_, value) => transport.send("ime", value).then(result => {
        if (value.mode !== "cancel" && !result.available) throw new Error("输入位置已变化，请重新输入");
        return result;
      }),
      preparePaste,
      pasteContent: (content, prepared) => receive(content, prepared?.lease || { target: transport.target(), epoch: generation.current, transport }, prepared),
    });
    controls.current = { transport, input };
    return () => {
      input.dispose(); transport.dispose();
      if (controls.current?.transport === transport) controls.current = null;
    };
  }, [screenVisible, state?.input, state?.persistent, inputChannel, image?.pid, image?.window, image?.video]);

  function receive(content, lease, prepared) {
    const target = lease?.target || frame.current;
    const epoch = lease?.epoch ?? generation.current;
    const transport = lease?.transport || controls.current?.transport;
    const valid = () => target && epoch === generation.current && transport?.valid(target);
    const ready = Promise.resolve(content).then(value => ({ value }), error => ({ error }));
    if (!transport) { prepared?.dispose(); return Promise.reject(new Error("窗口尚未连接，请稍后重试")); }
    return transport.run(async () => {
      const { value, error } = await ready;
      if (error) throw error;
      if (!valid()) throw new Error("窗口已切换，请回到原窗口重新粘贴");
      setFileError(""); setTransferring(true);
      if (value.files || value.fileSelection) {
        await sendFiles(value, "desktop", "", { valid, windowTarget: target, onProgress: (loaded, total) => onStatus(total ? `正在传递附件 · ${Math.floor(loaded * 100 / total)}%` : "正在传递附件…") });
      } else if (value.png) {
        await sendImage(value, "desktop", "", { prepared });
      } else if (value.text) {
        await request("text", { ...target, text: value.text });
      }
      if (valid()) onStatus(value.text ? "已粘贴" : `附件已交给 ${appName}，请在应用中确认上传结果`);
    }).finally(() => { prepared?.dispose(); setTransferring(false); });
  }
  const fileFailure = error => { setFileError(error.message); onStatus(error.message); };
  async function chooseFiles() {
    const lease = { target: frame.current, epoch: generation.current, transport: controls.current?.transport };
    if (!nativeAvailable()) { pickerTarget.current = lease; picker.current?.click(); return; }
    try {
      const selected = await native("chooseUploadFiles", { multiple: true });
      if (!selected.canceled) await receive({ fileSelection: selected.fileSelection, kind: "paste" }, lease);
    } catch (error) { fileFailure(error); }
  }
  if (!visible) return null;
  const loading = ["connecting", "starting", "waiting-window", "stopping"].includes(phase);
  return <section className="claude-desktop-view mac-claude" aria-label={"虚拟 Mac 中的 " + appName}>
    {(browser || !nativeAvailable()) && <BrowserUploads requests={uploads} onStatus={onStatus} />}
    <DesktopToolbar title={appName} desktop={state} platform="macOS" zoom={zoom} setZoom={setZoom} onConfirm={onConfirm} busy={loading}
      onStop={browser ? undefined : () => action("stop")} refresh={() => { if (!stopped.current) beginWaiting(); refresh(n => n+1); }} sidebarCollapsed={sidebarCollapsed} onExpand={onExpand}>
      {browser && <BrowserFavorites ready={Boolean(state?.installed)} onOpen={onOpenPage} />}
      <MacOSLogin />
      {!browser && <button disabled={loading || phase === "failed" || !state?.input || !image || transferring} onClick={() => void chooseFiles()}>添加附件</button>}
      {!browser && <input ref={picker} type="file" multiple hidden aria-label="选择 Claude 附件" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; if (files.length) void receive({ files, kind: "paste" }, pickerTarget.current || undefined).catch(fileFailure); }} />}
      {!loading && (!state?.running || error) && <button onClick={() => action("launch")} disabled={!state?.installed}>{state?.running ? "重新连接应用" : "打开应用"}</button>}
      {state?.installed && !state.screen && <button onClick={() => action("request-screen")}>授权窗口画面</button>}
      {state?.installed && !state.input && <button onClick={() => action("request-input")}>授权键鼠</button>}
    </DesktopToolbar>
    {state && !state.installed && <p>此虚拟 Mac 尚未安装 {appName}。</p>}
    {state?.running && !state.screen && <p>{messages.screen_recording_permission}</p>}
    {state?.running && state.screen && !state.input && <p>{messages.accessibility_permission}</p>}
    <div ref={pane} className="mac-claude-frame" aria-busy={loading} style={{ "--desktop-zoom": zoom }}>
      {loading && <div className="mac-app-placeholder" role="status" aria-live="polite">
        <LoaderCircle className="mac-app-spinner" size={28} aria-hidden="true" />
        <strong>{phase === "starting" ? `正在启动 ${appName}` : phase === "stopping" ? `正在关闭 ${appName}` : phase === "waiting-window" ? "正在连接窗口画面" : `正在连接 ${appName}`}</strong>
        <p>{slow ? "首次打开可能需要更长时间，窗口出现后会自动显示，无需重复点击。" : "请稍候，准备好后会自动显示。"}</p>
      </div>}
      {(!image || phase === "failed") && !loading && <div className="mac-app-placeholder" role={phase === "failed" ? "alert" : undefined}>
        <Monitor size={28} aria-hidden="true" />
        <strong>{phase === "stopped" ? `${appName} 已关闭` : phase === "uninstalled" ? `尚未安装 ${appName}` : phase === "permission" ? "需要允许显示窗口" : "窗口画面暂不可用"}</strong>
        <p>{phase === "stopped" ? "点击上方「打开应用」即可继续使用。" : error || "请按照上方提示完成设置。"}</p>
      </div>}
      {(error && image && phase !== "failed" || fileError) && <div className="mac-claude-alerts">
        {error && image && phase !== "failed" && <p role="alert">{error}</p>}
        {fileError && <p role="alert">{fileError}</p>}
      </div>}
      {image?.video && <canvas ref={surface} key={"video-" + videoKey(image)} data-frame={videoKey(image)} role="img" aria-label={appName + " 客机窗口"} />}
      {image && !image.video && <img ref={surface} key={videoKey(image)} alt={appName + " 客机窗口"} src={image.src} draggable={false}
        onLoad={e => {
          const img = e.currentTarget;
          if (!browser && !decoded.current && !hasWindowContent(img, startupSample)) {
            frame.current = null;
            if (waiting.current !== null) setPhase("waiting-window");
            // Release push backpressure so the first painted frame can arrive.
            image.acknowledge?.();
            return;
          }
          const width = image.width || img.naturalWidth;
          const height = image.height || img.naturalHeight;
          img.style.setProperty("--frame-width", width + "px");
          img.style.setProperty("--frame-aspect", width / height);
          frame.current = { window: image.window, pid: image.pid, geometry: image.geometry, surface: browser ? "browser" : undefined };
          matchWindowBackground(img, pane.current, backgroundSample);
          decoded.current = true;
          waiting.current = null; setWaitingSince(null); setPhase("ready"); setError("");
          image.acknowledge?.();
        }}
        onError={() => { frameConnection.current?.close(); frameConnection.current = null; frame.current = null; setImage(null); windowFailure("decode_failed", "窗口画面无法解码，请重新连接。"); }}
        />}
    </div>
  </section>;
}
