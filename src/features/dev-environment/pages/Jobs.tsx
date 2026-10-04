import { useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Chip } from "@heroui/chip";
import { Tooltip } from "@heroui/tooltip";
import { addToast } from "@heroui/toast";
import { Clipboard, Download, Pause, Play, RefreshCw, Trash2, X } from "lucide-react";
import { reportError, useDevEnv } from "../DevEnvContext";
import type { InstallJob, JobStatus } from "../types";

const labels: Record<JobStatus, string> = {
  queued: "排队中",
  running: "进行中",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function JobRow({ job }: { job: InstallJob }) {
  const { refresh, refreshJobs, catalog, settings } = useDevEnv();
  const [busy, setBusy] = useState(false);
  const name = catalog.find((entry) => entry.id === job.languageId)?.name || job.languageId;
  const percent = Math.max(0, Math.min(100, Math.round(job.progress || 0)));
  const active = job.status === "running" || job.status === "queued";
  const waitingForSource = Boolean(job.awaitingConfirmation);
  const statusLabel = job.awaitingConfirmation ? "等待确认" : labels[job.status];
  const visibleLogs = (job.logs || []).filter((line) => settings.logLevel !== "error" || line.includes("[ERROR]"));

  const act = async (action: "pause" | "resume" | "cancel") => {
    if (!window.devEnv) return;
    setBusy(true);
    try {
      await window.devEnv[action](job.id);
      await refreshJobs();
      if (action === "cancel") await refresh();
    } catch (error) {
      reportError(action === "pause" ? "暂停失败" : action === "resume" ? "继续失败" : "取消失败", error);
    } finally {
      setBusy(false);
    }
  };

  const copyLogs = async () => {
    try {
      await navigator.clipboard.writeText(visibleLogs.join("\n"));
      addToast({ title: "日志已复制", timeout: 1800 });
    } catch (error) {
      reportError("复制失败", error);
    }
  };

  const confirmSource = async (accept: boolean) => {
    if (!window.devEnv) return;
    setBusy(true);
    try {
      await window.devEnv.confirmSource(job.id, accept);
      await refreshJobs();
    } catch (error) {
      reportError(accept ? "切换源失败" : "取消切换失败", error);
    } finally {
      setBusy(false);
    }
  };

  const removeJob = async () => {
    if (!window.devEnv) return;
    setBusy(true);
    try {
      await window.devEnv.removeJob(job.id);
      await refreshJobs();
      addToast({ title: "任务记录已删除", timeout: 1800 });
    } catch (error) {
      reportError("删除任务失败", error);
    } finally {
      setBusy(false);
    }
  };

  return <div className="dev-job-row">
    <div className="flex flex-wrap items-center gap-3">
      <span className={`dev-job-icon ${job.status === "completed" ? "done" : ""}`}><Download size={19} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{name}</strong><span className="font-jetbrains text-xs text-default-400">{job.version}</span></div>
        <p className="mt-0.5 text-xs text-default-400">{job.stage || labels[job.status]}</p>
      </div>
      <Chip size="sm" variant="flat" color={job.status === "completed" ? "success" : job.status === "failed" ? "danger" : job.status === "paused" ? "warning" : job.status === "running" ? "primary" : "default"}>{statusLabel}</Chip>
      <span className="w-10 text-right font-jetbrains text-xs tabular-nums text-default-400">{percent}%</span>
    </div>
    <div className="dev-progress mt-3"><span style={{ width: `${percent}%` }} className={job.status === "failed" ? "failed" : job.status === "completed" ? "completed" : ""} /></div>
    {job.awaitingConfirmation && job.sourceConfirmation && <div className="dev-source-confirm">
      <strong>主下载源失败，是否切换备用源？</strong>
      <p>失败源：<code>{job.sourceConfirmation.failedUrl}</code></p>
      <p>备用源：<code>{job.sourceConfirmation.nextUrl}</code></p>
      <p className="text-danger">{job.sourceConfirmation.error}</p>
      <div className="dev-source-confirm-actions">
        <Button size="sm" color="primary" radius="sm" isLoading={busy} onPress={() => void confirmSource(true)}>确认切换源</Button>
        <Button size="sm" variant="flat" color="danger" radius="sm" isLoading={busy} onPress={() => void act("cancel")}>取消任务</Button>
      </div>
    </div>}
    {job.error && <p className="mt-2 break-words text-xs text-danger">{job.error}</p>}
    <div className="mt-3 flex items-center gap-1">
      {active && <Tooltip content="暂停"><Button isIconOnly aria-label="暂停任务" size="sm" radius="sm" variant="light" isDisabled={busy || job.status === "queued"} onPress={() => void act("pause")}><Pause size={16} /></Button></Tooltip>}
      {job.status === "paused" && !waitingForSource && <Tooltip content="继续"><Button isIconOnly aria-label="继续任务" size="sm" radius="sm" variant="light" isDisabled={busy} onPress={() => void act("resume")}><Play size={16} /></Button></Tooltip>}
      {(active || job.status === "paused") && <Tooltip content="取消"><Button isIconOnly aria-label="取消任务" size="sm" radius="sm" variant="light" color="danger" isDisabled={busy} onPress={() => void act("cancel")}><X size={16} /></Button></Tooltip>}
      {(job.status === "failed" || job.status === "cancelled" || job.status === "paused") && <Tooltip content="删除任务记录"><Button isIconOnly aria-label="删除任务记录" size="sm" radius="sm" variant="light" color="danger" isDisabled={busy} onPress={() => void removeJob()}><Trash2 size={16} /></Button></Tooltip>}
    </div>
    <div className="dev-log-head"><span>任务日志</span><Tooltip content="复制日志"><Button aria-label="复制日志" isIconOnly size="sm" variant="light" radius="sm" onPress={copyLogs}><Clipboard size={14} /></Button></Tooltip></div>
    <pre className="dev-log">{visibleLogs.length ? visibleLogs.join("\n") : "暂无日志"}</pre>
  </div>;
}

export default function DevJobs() {
  const { jobs, refreshJobs } = useDevEnv();
  const [filter, setFilter] = useState<"all" | "active" | "history">("all");
  const [refreshing, setRefreshing] = useState(false);
  const sorted = useMemo(() => [...jobs].reverse().filter((job) => filter === "all" || (filter === "active" ? ["queued", "running", "paused"].includes(job.status) : ["completed", "failed", "cancelled"].includes(job.status))), [jobs, filter]);
  const activeCount = jobs.filter((job) => ["queued", "running", "paused"].includes(job.status)).length;
  const doRefresh = async () => { setRefreshing(true); try { await refreshJobs(); } finally { setRefreshing(false); } };

  return <div className="dev-page">
    <div className="dev-page-head"><div><h1>安装任务</h1><p>查看下载、校验和安装进度</p></div><Tooltip content="刷新任务"><Button isIconOnly aria-label="刷新任务" variant="flat" radius="sm" isLoading={refreshing} onPress={doRefresh}><RefreshCw size={17} /></Button></Tooltip></div>
    <div className="dev-stats"><span><strong>{activeCount}</strong> 进行中</span><span><strong>{jobs.filter((item) => item.status === "completed").length}</strong> 已完成</span><span><strong>{jobs.filter((item) => item.status === "failed").length}</strong> 失败</span></div>
    <div className="dev-toolbar"><div className="dev-filters" role="group" aria-label="任务筛选"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部</button><button className={filter === "active" ? "active" : ""} onClick={() => setFilter("active")}>进行中</button><button className={filter === "history" ? "active" : ""} onClick={() => setFilter("history")}>历史</button></div></div>
    {sorted.length === 0 ? <div className="dev-empty-state"><Download size={25} /><strong>{filter === "active" ? "当前没有进行中的任务" : filter === "history" ? "还没有历史任务" : "还没有安装任务"}</strong></div> : <div className="dev-jobs-list">{sorted.map((job) => <JobRow key={job.id} job={job} />)}</div>}
    <p className="dev-footer-note">最多同时运行 3 个独立任务；单个文件最多使用 4 个并行下载连接。串行安装步骤会自动排队。</p>
  </div>;
}
