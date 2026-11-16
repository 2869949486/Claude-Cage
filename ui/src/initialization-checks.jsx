import React from "react";
import { MacOSLogin } from "./macos-login";

// Recovery codes come from the operation that failed. Project status also
// supports restoring the flow after the in-memory job has been replaced.
export function initializationRecovery(status) {
  if (status?.guest_system !== "macos") return null;
  const workspace = status.workspace;
  const failure = status.project_errors?.find(item => item.path === workspace);
  if (failure) return { ...failure, workspace };
  if (status.job?.error && status.job.recovery) return { recovery: status.job.recovery, message: status.job.error, workspace: status.job.workspace || workspace };
  const restartMessage = "出口地址或环境设置变化需要重启环境";
  if ([status.job?.error, status.safety?.error].includes(restartMessage)) return { recovery: "environment-restart", message: "网络设置已更新，需要重启虚拟 Mac 才能生效。点击下方按钮，Cage 会保留已有系统和文件，重启后重新检查。", workspace };
  return { workspace };
}

export function InitializationChecks({ status, busy, onWorkspace, onCheck, onStart, onRestart, onUpdate, onDiagnostics }) {
  const recovery = initializationRecovery(status);
  const code = recovery?.recovery;
  const workspaceChecked = !code && status.safety?.report?.checks?.some(check => check.id === "filesystem_boundary" && check.state === "passed");
  const needsWorkspace = recovery?.workspace && !workspaceChecked && (!code || ["project-approval", "project-retry"].includes(code));
  return <section className="initialization-notice" aria-label="完成安装检查">
    <h2>{code === "project-approval" ? "允许虚拟 Mac 使用文件夹" : code === "guest-login" ? "先登录虚拟 Mac" : code === "filesystem-permission" ? "先启用文件共享权限" : "检查文件访问和网络连接"}</h2>
    <p>{code === "project-approval" ? "终端和编辑器需要你的允许，才能打开、保存这个文件夹中的文件。点击下方按钮，确认文件夹后允许即可。" : code === "guest-login" ? "虚拟 Mac 当前停留在登录或锁定画面。请打开画面，登录后返回这里继续检查。" : code === "filesystem-permission" ? "文件共享所需的系统开关还未开启。打开授权设置后，按提示开启开关，再返回这里检查。" : recovery?.message || status.job?.error || status.safety?.error || (recovery?.workspace ? "先确认文件夹可以使用，再检查网络是否可用、访问范围是否符合设置。检查通过后就能进入工作台。" : "接下来确认网络可用、访问范围符合设置。项目文件夹可以进入工作台后添加。")}</p>
    {needsWorkspace && <p className="macos-approval-path">文件夹：{recovery.workspace}</p>}
    {code === "project-approval" && <p>这次只允许所示文件夹及其内容，其中的修改会同步到本机。允许后会自动继续检查。</p>}
    {code === "filesystem-permission" && <p>在虚拟 Mac 中打开 macFUSE 和 macFUSE (local) 两个开关，完成后返回这里继续。</p>}
    {code === "guest-login" && <MacOSLogin disabled={busy} onSessionClosed={onCheck} />}
    {code === "filesystem-permission" && <MacOSLogin maintenance="projects" disabled={busy} onSessionClosed={onCheck} />}
    <div className="initialization-recovery">
      {["environment-update", "environment-restart"].includes(code) ? <>
        {code === "environment-update" && <button className="primary" disabled={busy} onClick={onUpdate}>同步环境组件</button>}
        <button disabled={busy} onClick={code === "environment-restart" ? onRestart : onStart}>{code === "environment-restart" ? "保存后重启并检查" : "重新连接并检查"}</button>
      </> : <button className="primary" disabled={busy || !status.ready} onClick={() => needsWorkspace ? onWorkspace(recovery.workspace) : onCheck()}>{code === "project-approval" ? "确认文件夹并继续" : needsWorkspace ? "连接文件夹并继续检查" : "重新检查并继续"}</button>}
      {code === "project-directory" && <button disabled={busy} onClick={onDiagnostics}>查看诊断记录</button>}
    </div>
    <p className="mac-setup-retention">检查通过前，虚拟 Mac 暂时不能联网。授权与检查可以重试，已有安装和个人文件会保留。</p>
  </section>;
}

export function InitializationDetails({ status }) {
  const job = status?.job || {};
  const reasons = [...new Set([job.error, status?.safety?.error, status?.network_error].filter(Boolean))];
  const checks = status?.safety?.report?.checks || [];
  const labels = { passed: "已通过", failed: "未通过", unknown: "尚未完成" };
  return <div className="modal-body">
    <p>{job.running ? "当前操作" : "最近一次操作"}：{job.message || "尚未开始"}</p>
    {reasons.map(reason => <p key={reason} role="alert">{reason}</p>)}
    {checks.length > 0 && <><h3>最近一次检查结果</h3><ol className="initialization-checks">{checks.map(check => <li key={check.id}>
      <strong>{check.title} · {labels[check.state] || "尚未完成"}</strong>
      <p>{check.evidence}</p>{check.state !== "passed" && check.remedy && <p>{check.remedy}</p>}
    </li>)}</ol></>}
    <h3>操作记录</h3><pre className="job-log">{job.log || "当前操作没有额外日志。失败原因显示在上方，完整记录可在「日志与诊断」中导出。"}</pre>
  </div>;
}
