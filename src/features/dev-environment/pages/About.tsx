import { Button } from "@heroui/button";
import { Github, RefreshCw, Users, ShieldCheck, ExternalLink, PackageCheck, MonitorCog } from "lucide-react";
import Logo from "@/components/Logo";
import { useEffect, useState } from "react";
import { versionCompare } from "@/utils/versionCompare";
import { CURRENT_VERSION } from "@/constants/version";
import { siteConfig } from "@/constants/site";

type AppVersion = { appVersion: string; channel: string; publishedAt: string };
type UpdateLog = { latestVersion: string; updatedAt: string; entries: Array<{ version: string; date: string; summary: string; changes: Array<{ type: "新增" | "优化" | "修复"; text: string }> }> };

const versionUrl = `${siteConfig.links.mirrorRaw}/app-version.json`;
const updateUrl = `${siteConfig.links.mirrorRaw}/update.json`;

export default function DevAbout() {
  const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const [appVersion, setAppVersion] = useState<AppVersion | null>(null);
  const [updateLog, setUpdateLog] = useState<UpdateLog | null>(null);
  const [checking, setChecking] = useState(false);
  const [versionError, setVersionError] = useState("");

  const loadVersionData = async () => {
    setChecking(true);
    setVersionError("");
    try {
      const read = async <T,>(remote: string, local: string): Promise<T> => {
        const remoteResponse = await fetch(remote, { cache: "no-store" });
        if (remoteResponse.ok) return await remoteResponse.json() as T;
        const localResponse = await fetch(local, { cache: "no-store" });
        if (!localResponse.ok) throw new Error("镜像仓库版本数据暂时不可用");
        return await localResponse.json() as T;
      };
      const [versionData, updateData] = await Promise.all([
        read<AppVersion>(versionUrl, "/version/app-version.json"),
        read<UpdateLog>(updateUrl, "/version/update.json"),
      ]);
      setAppVersion(versionData);
      setUpdateLog(updateData);
    } catch (error) {
      setVersionError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => { void loadVersionData(); }, []);
  const latestVersion = appVersion?.appVersion || updateLog?.latestVersion || CURRENT_VERSION;
  const hasUpdate = versionCompare(latestVersion, CURRENT_VERSION) > 0;
  const latestEntry = updateLog?.entries?.[0];

  return <div className="dev-page">
    <div className="dev-page-head"><div><span className="dev-eyebrow">ALTAR / PRODUCT</span><h1>关于 Altar</h1><p>一个清晰、可复用的 Windows 开发环境工作台。</p></div></div>
    <section className="dev-about-hero">
      <div className="dev-about-logo-large"><Logo size={92} /></div>
      <div className="dev-about-hero-copy"><span className="dev-eyebrow">WINDOWS DEVELOPMENT WORKSPACE</span><h2>Altar</h2><p>发现、安装并维护常用开发环境</p><span className="dev-version-pill">当前版本 v{CURRENT_VERSION}</span></div>
      <div className="dev-about-hero-actions"><Button className="dev-github-button" startContent={<Github size={17} />} onPress={() => openExternal(siteConfig.links.github)}>源码仓库</Button><Button isIconOnly variant="light" aria-label="刷新版本信息" onPress={() => void loadVersionData()}><RefreshCw size={17} className={checking ? "animate-spin" : ""} /></Button></div>
    </section>
    <section className="dev-about-overview">
      <div className="dev-about-overview-item"><MonitorCog size={19} /><div><strong>统一管理</strong><span>在一个界面查看环境、版本和安装任务。</span></div></div>
      <div className="dev-about-overview-item"><PackageCheck size={19} /><div><strong>来源可追溯</strong><span>官方源、地区备用源和 GitHub 镜像清晰可见。</span></div></div>
      <div className="dev-about-overview-item"><ShieldCheck size={19} /><div><strong>校验后安装</strong><span>下载完成后按发布元数据核对文件完整性。</span></div></div>
    </section>
    <section className="dev-settings-section">
      <div className="dev-section-intro"><ShieldCheck size={19} /><div><h2>版本与更新</h2><p>版本数据和更新日志来自 Altar GitHub 镜像仓库。</p></div></div>
      <div className="dev-about-grid"><div><span>当前版本</span><strong>{CURRENT_VERSION}</strong></div><div><span>镜像版本</span><strong>{latestVersion}</strong></div><div><span>状态</span><strong className={hasUpdate ? "dev-update-text" : ""}>{hasUpdate ? "有新版本" : "已是最新"}</strong></div></div>
      {versionError && <p className="dev-version-error mt-3">{versionError}</p>}
      {latestEntry && <div className="dev-release-note"><div><span className="dev-eyebrow">LATEST UPDATE · {latestEntry.date}</span><h3>v{latestEntry.version} · {latestEntry.summary}</h3></div><div className="dev-release-timeline">{latestEntry.changes.map((change) => <div className="dev-timeline-item" key={`${change.type}-${change.text}`}><span className={`dev-change-tag ${change.type === "新增" ? "new" : change.type === "修复" ? "fix" : "improve"}`}>{change.type}</span><p>{change.text}</p></div>)}</div></div>}
    </section>
    <section className="dev-about-links"><div><Users size={18} /><div><strong>Altar Team</strong><span>为个人开发者打造可复用的 Windows 工具链。</span></div></div><Button variant="light" endContent={<ExternalLink size={15} />} onPress={() => openExternal(siteConfig.links.mirrorRaw)}>查看镜像数据</Button></section>
  </div>;
}
