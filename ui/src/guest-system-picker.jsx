import React, { useEffect, useState } from "react";
import { api } from "./api";
import { InlineSelect } from "./inline-select";
import "./guest-system-picker.css";

const names = { "debian-12": "Debian 12", "debian-13": "Debian 13", "ubuntu-22.04": "Ubuntu 22.04", "ubuntu-24.04": "Ubuntu 24.04", macos: "macOS", "windows-11": "Windows 11" };
const editions = { Professional: "专业版", ProfessionalN: "专业版 N", Enterprise: "企业版", EnterpriseN: "企业版 N", Education: "教育版", EducationN: "教育版 N", Core: "家庭版", CoreSingleLanguage: "家庭单语言版" };
const languages = { "zh-CN": "简体中文", "zh-TW": "繁体中文", "en-US": "英语（美国）" };

export function HostCloneSummary({ pending, onChange }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    api("/environment/guest-systems/clone").then((next) => {
      if (!active) return;
      setResult(next);
      onChange((current) => current?.clone ? { ...current, clone_key: next.key, clone_ready: next.enough_space } : current);
    }).catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [attempt, onChange]);
  if (error) return <div className="guest-install-fields" role="alert"><small>{error}</small>
    <button type="button" onClick={() => { setError(""); retry((value) => value + 1); }}>重新检测并匹配</button></div>;
  if (!result) return <small className="guest-install-fields" role="status">正在检测本机系统版本并匹配官方镜像…</small>;
  const plan = result.plan;
  const host = plan.host;
  const download = result.download_bytes > 0 ? `${(result.download_bytes / 1e9).toFixed(2)} GB` : "";
  const source = host.system === "macos" ? "Apple" : host.system === "windows-11" ? "微软" : "发行版官方源";
  const cached = Boolean(plan.path || result.download_bytes === 0 && plan.bytes > 0);
  return <div className="guest-install-fields host-clone-summary" aria-live="polite">
    <strong>将安装：{names[host.system]} {host.system === "windows-11" ? `${host.version} · ${editions[host.edition] || host.edition} · ${languages[host.language] || host.language}` : host.system === "macos" ? plan.version : ""}</strong>
    <small>{pending ? "沿用首次选择的系统镜像，继续安装独立客机。" : "根据本机系统版本匹配官方镜像，安装到独立客机中。"}</small>
    {host.build && <small>{pending ? "首次检测的本机构建号" : "本机构建号"} {host.build} · 镜像构建号 {plan.build}</small>}
    {host.system === "windows-11" && host.build !== plan.build && <small>Windows 的发行版本、版本类型和语言与本机一致，补丁版本有所不同。</small>}
    {host.system === "macos" && host.version !== plan.version && <small>本机为 macOS {host.version}。当前 Apple 目录没有完全相同的安装包，将安装同一 macOS 主版本的官方更新。</small>}
    <small>本机的应用、个人文件和登录状态不会复制；客机中的工具、账户和文件会持续保存。</small>
    <small>{cached ? "已找到匹配的本地镜像，校验后直接使用，无需重新下载系统镜像。" : `从 ${source} 下载官方系统镜像，${download ? `预计还需下载 ${download}` : "下载大小将在连接后显示"}。`}</small>
    <small>{result.installation_started ? "继续使用原虚拟磁盘，保留已有安装进度。" : `至少需要 ${result.minimum_free_gib} GiB 可用空间，虚拟磁盘按实际使用增长。`}浏览器、编辑器等工作台组件按需下载。</small>
    {!result.enough_space && <small role="alert">当前可用 {result.free_gib} GiB，请在存储设置中选择空间充足的位置，再重新检查。</small>}
    {!pending && <button type="button" onClick={() => {
      setResult(null);
      onChange((current) => current?.clone ? { ...current, clone_key: "", clone_ready: false } : current);
      retry((value) => value + 1);
    }}>重新检测并匹配</button>}
  </div>;
}

export function GuestSystemPicker({ system, onChange, onReselect, preserveOnUnmount = false, deferMatch = false }) {
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    api("/environment/guest-systems").then((next) => {
      if (!active) return;
      setView(next);
      if (next.fresh || next.pending) {
        onChange(current => !next.pending && current && !current.pending ? current : ({ guest_system: next.pending?.system || "debian-13", media: next.pending?.media || "",
          sha256: next.pending?.sha256 || "", editor_terms: Boolean(next.pending?.editor_terms),
          clone: Boolean(next.pending?.source && !next.pending?.source_kind), clone_key: "", clone_ready: false,
          pending: Boolean(next.pending) }));
      } else onChange(null);
    }).catch((e) => {
      if (!active) return;
      if (e.status === 403 || e.status === 404) onChange(null);
      else setError(e.message);
    });
    return () => { active = false; if (!preserveOnUnmount) onChange(undefined); };
  }, [onChange, attempt, preserveOnUnmount]);
  if (!view || !system) return error ? <div className="guest-system-picker"><span role="alert">{error}</span>
    <button type="button" onClick={() => retry((n) => n + 1)}>重新检查安装选项</button></div> : null;
  const os = system.guest_system;
  return (
    <div className="guest-system-picker">
      <span>客户机系统</span>
      <InlineSelect inline aria-label="客户机系统" value={system.clone ? "host" : os} disabled={system.pending}
        onValueChange={(value) => onChange({ guest_system: value === "host" ? view.system : value, clone: value === "host", clone_key: "", clone_ready: false, media: "", sha256: "", editor_terms: false })}>
        {Boolean(view.system) && <option value="host" disabled={!view.available}>自动匹配本机系统版本{view.available ? "" : "（暂不可用）"}</option>}
        <option value="debian-13">Debian 13</option>
        <option value="ubuntu-22.04" disabled={!view.linux_systems?.includes("ubuntu-22.04")}>Ubuntu 22.04{view.linux_systems?.includes("ubuntu-22.04") ? "" : "（此构建暂不可用）"}</option>
        {os === "macos" && <option value="macos" disabled>macOS（已不再支持）</option>}
        {os === "windows-11" && <option value="windows-11" disabled>Windows 11（已不再支持）</option>}
      </InlineSelect>
      {system.clone && (deferMatch ? <small className="guest-install-fields">Cage 会检测本机系统版本，在下一步显示匹配的官方镜像、下载量与空间要求。</small> : <HostCloneSummary pending={system.pending} onChange={onChange} />)}
      <small className="guest-install-fields">系统镜像通过主机网络下载，遵循主机系统代理或 TUN 设置，不使用 Cage 的客机代理。使用 Clash 等软件时，请先开启系统代理或 TUN；代理规则决定镜像网站的实际出口。</small>
      {!system.clone && os === "ubuntu-22.04" && <div className="guest-install-fields">
          <small>从 Ubuntu 官方源下载 Ubuntu 22.04 LTS 镜像，并校验 SHA-256。Cage 按主机架构选择 ARM64 或 x86_64。</small>
          <small>自动安装开发工具、浏览器和编辑器。客机账户、文件和登录状态保存在独立的持久虚拟磁盘中。</small>
          <small>至少需要 17 GiB 可用空间。失败后可继续原安装，不会改用其他系统或覆盖已有环境。</small>
      </div>}
      {view.reason && !view.available && <small className="guest-install-fields">{view.reason}</small>}
      {view.reselect && <button type="button" className="guest-install-fields" onClick={async () => {
        try {
          await api("/environment/guest-systems", { id: view.pending.id }, "DELETE");
          setView(await api("/environment/guest-systems"));
          onChange({ guest_system: "debian-13", clone: false, clone_key: "", clone_ready: false, media: "", sha256: "", editor_terms: false });
          onReselect?.();
        } catch (e) { setError(e.message); }
      }}>重新选择系统或镜像</button>}
      {error && <p role="alert" className="guest-install-fields">{error}</p>}
    </div>
  );
}

export function validGuestChoice(value) {
  if (value?.clone) return Boolean(value.clone_key && value.clone_ready);
  return !value || value.guest_system === "debian-13" || value.guest_system === "ubuntu-22.04";
}
