import React, { useRef, useState, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  Monitor,
  Columns2,
  Power,
} from "lucide-react";
import RFB from "../.generated/novnc/core/rfb.js";
import { api } from "./api";
import { runtimeSocketURL } from "./client-context.mjs";

const title = (a) => `#${String(a.number).padStart(2, "0")} ${a.label}`;
const entry = (id) => "/desktop-instances/" + id;
export function useAccountDesktops(onShow, onHide, notify, confirm) {
  const [expanded, setExpanded] = useState(false);
  const [catalog, setCatalog] = useState(null);
  const [panes, setPanes] = useState([]);
  const [pending, setPending] = useState("");
  const lock = useRef(false);
  const generation = useRef(0);
  async function refresh() {
    const g = ++generation.current;
    try {
      const next = await api("/desktop-instances");
      if (g === generation.current) setCatalog(next);
    } catch (e) {
      if (g === generation.current) notify(e.message);
    }
  }
  async function act(account, action, beside = false) {
    if (lock.current) return;
    lock.current = true;
    try {
      if (
        action === "stop" &&
        !(await confirm({
          title: "关闭 " + title(account) + "？",
          body: "请先保存这个 Desktop 中的工作。",
          confirm: "关闭实例",
        }))
      )
        return;
      setPending(account.id);
      let job = await api(entry(account.id) + "/" + action, {});
      while (job.running) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        job = await api("/agent/jobs/" + job.id);
      }
      if (job.error || job.canceled) throw new Error(job.error || "操作已取消");
      if (action === "start") {
        setPanes((old) => {
          if (!beside || !old.length) return [account];
          if (old.some((pane) => pane.id === account.id)) return old;
          return [old[0], account];
        });
        onShow();
      } else {
        setPanes((old) => old.filter((a) => a.id !== account.id));
        if (panes.length === 1 && panes[0].id === account.id) onHide();
      }
      await refresh();
      return true;
    } catch (e) {
      notify(e.message);
    } finally {
      lock.current = false;
      setPending("");
    }
  }
  return {
    expanded,
    catalog,
    panes,
    pending,
    act,
    refresh,
    clear: () => setPanes([]),
    toggle: () => {
      if (!expanded) void refresh();
      setExpanded(!expanded);
    },
  };
}

export function DesktopList({ model, disabled, selected, onDefault }) {
  const { catalog, expanded, panes, pending } = model;
  return (
    <div className="account-desktop-nav">
      <button
        className={"sidebar-link " + (selected ? "selected" : "")}
        aria-expanded={expanded}
        onClick={model.toggle}
      >
        <Monitor size={17} />
        Claude Desktop{" "}
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {expanded && (
        <div className="account-desktop-list">
          <button className="sidebar-link" disabled={disabled} onClick={onDefault}>
            默认 Desktop
          </button>
          {catalog?.supported &&
            catalog.accounts.map((a) => (
              <div className="account-desktop-row" key={a.id}>
                <button
                  title={title(a) + (a.running ? " · 运行中" : " · 未启动")}
                  aria-pressed={selected && panes.some((p) => p.id === a.id)}
                  className="sidebar-link"
                  disabled={Boolean(pending) || disabled}
                  onClick={() => model.act(a, "start")}
                >
                  {title(a)}
                  {pending === a.id ? " …" : a.running ? " ●" : ""}
                </button>
                {panes.length > 0 && !panes.some((p) => p.id === a.id) && (
                  <button
                    className="icon-button"
                    disabled={Boolean(pending) || disabled}
                    aria-label={"并排打开 " + title(a)}
                    onClick={() => model.act(a, "start", true)}
                  >
                    <Columns2 size={14} />
                  </button>
                )}
                {a.running && (
                  <button
                    className="icon-button"
                    disabled={Boolean(pending) || disabled}
                    aria-label={"关闭 " + title(a)}
                    onClick={() => model.act(a, "stop")}
                  >
                    <Power size={14} />
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function DesktopPane({ account, visible, close, busy }) {
  const box = useRef(null);
  const [message, setMessage] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let live = true,
      client;
    setMessage("正在连接…");
    const path = entry(account.id);
    api(path + "/vnc-credentials")
      .then(({ password }) => {
        if (!live) return;
        client = new RFB(box.current, runtimeSocketURL(path + "/vnc"), {
          credentials: { password },
        });
        client.scaleViewport = true;
        client.resizeSession = true;
        client.focusOnClick = true;
        client.addEventListener("connect", () => {
          if (live) setMessage("");
        });
        client.addEventListener("disconnect", () => {
          if (live) setMessage("画面已断开");
        });
      })
      .catch((e) => {
        if (live) setMessage(e.message);
      });
    return () => {
      live = false;
      client?.disconnect();
    };
  }, [account.id, visible, attempt]);
  return (
    <section className="account-desktop-pane" aria-label={title(account)}>
      <header>
        <strong>{title(account)}</strong>
        <button disabled={busy} onClick={close}>
          关闭实例
        </button>
      </header>
      <div className="account-desktop-screen" ref={box} />
      {message && (
        <div className="account-desktop-message" role="status">
          {message}{" "}
          {message !== "正在连接…" && (
            <button onClick={() => retry(attempt + 1)}>重新连接</button>
          )}
        </div>
      )}
    </section>
  );
}

export function DesktopPanes({ model, visible }) {
  return (
    <div className="account-desktop-panes">
      {model.panes.map((a) => (
        <DesktopPane
          key={a.id}
          account={a}
          visible={visible}
          busy={Boolean(model.pending)}
          close={() => model.act(a, "stop")}
        />
      ))}
    </div>
  );
}
