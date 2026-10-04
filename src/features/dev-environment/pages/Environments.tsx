import { useEffect, useMemo, useState } from "react";
import { Button } from "@heroui/button";
import { Chip } from "@heroui/chip";
import { Input } from "@heroui/input";
import { Select, SelectItem } from "@heroui/select";
import { Switch } from "@heroui/switch";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { Tooltip } from "@heroui/tooltip";
import { addToast } from "@heroui/toast";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, FolderOpen, Info, Plus, RefreshCw, Search, Trash2, ArrowUpCircle } from "lucide-react";
import { useDevEnv, reportError } from "../DevEnvContext";
import type { CatalogEntry, InstallRequest, Installation, InstallScope, SourceRegion } from "../types";

type LanguageMeta = { id: string; label: string; mark: string; group: string; tint: string; description: string };

const languages: LanguageMeta[] = [
  { id: "python", label: "Python", mark: "Py", group: "常用", tint: "#3776ab", description: "数据分析、自动化与应用开发" },
  { id: "node", label: "Node.js", mark: "JS", group: "常用", tint: "#67a451", description: "JavaScript 运行时与 npm" },
  { id: "jdk", label: "JDK", mark: "J", group: "常用", tint: "#e9a23b", description: "Java 开发工具包" },
  { id: "go", label: "Go", mark: "Go", group: "常用", tint: "#3babc5", description: "Go 编译器与工具链" },
  { id: "rust", label: "Rust", mark: "Rs", group: "常用", tint: "#bb7657", description: "Rust 编译器与 Cargo" },
  { id: "dotnet", label: ".NET SDK", mark: ".N", group: "常用", tint: "#9272ce", description: "C#、F# 与 .NET 开发工具" },
  { id: "cpp", label: "C/C++", mark: "C+", group: "工具链", tint: "#6595db", description: "MSYS2 编译器与基础工具" },
  { id: "php", label: "PHP", mark: "Ph", group: "语言", tint: "#777bb3", description: "PHP 解释器" },
  { id: "ruby", label: "Ruby", mark: "Rb", group: "语言", tint: "#c05d62", description: "Ruby 解释器与 RubyGems" },
  { id: "dart", label: "Dart", mark: "Dt", group: "语言", tint: "#3aa6b5", description: "Dart SDK" },
  { id: "r", label: "R", mark: "R", group: "语言", tint: "#6d96c8", description: "统计计算与数据科学" },
  { id: "julia", label: "Julia", mark: "Jl", group: "语言", tint: "#a88bc7", description: "高性能数值计算" },
  { id: "perl", label: "Perl", mark: "Pl", group: "语言", tint: "#8293ad", description: "Perl 解释器" },
  { id: "lua", label: "Lua", mark: "Lu", group: "工具链", tint: "#5b8cc2", description: "MSYS2 Lua 运行环境" },
  { id: "kotlin", label: "Kotlin", mark: "Kt", group: "JVM", tint: "#b474c9", description: "Kotlin 编译器，需要 JDK" },
  { id: "scala", label: "Scala", mark: "Sc", group: "JVM", tint: "#d07870", description: "Scala 工具链，需要 JDK" },
];

const regionLabels: Record<SourceRegion, string> = {
  auto: "自动选择",
  china: "中国大陆",
  international: "国际官方",
};

const regionDetails: Record<SourceRegion, string> = {
  auto: "官方源优先，失败时尝试可验证镜像",
  china: "中国大陆镜像优先，失败时回退官方源",
  international: "仅使用官方国际源",
};

function formatOrigin(installation: Installation) {
  if (installation.managed) return "由本工具安装";
  return installation.source || "系统中已有";
}

function getErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed/i.test(message) ? "网络请求失败，版本源暂时不可访问。" : message;
}

function displayVersion(version: string) {
  return version === "latest" ? "最新稳定版" : version;
}

function EnvironmentDetails({ entry, meta, installed }: { entry: CatalogEntry; meta: LanguageMeta; installed: Installation[] }) {
  const { settings, refresh } = useDevEnv();
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [versionsError, setVersionsError] = useState("");
  const [versionRetry, setVersionRetry] = useState(0);
  const [scope, setScope] = useState<InstallScope>("user");
  const [customPath, setCustomPath] = useState("");
  const [addToPath, setAddToPath] = useState(true);
  const [source, setSource] = useState<SourceRegion>(settings.sourceRegion);
  const [withTypeScript, setWithTypeScript] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ kind: "activate" | "update" | "uninstall"; installation: Installation } | null>(null);
  const [busy, setBusy] = useState(false);
  const supportsCustomPath = entry.supportsCustomPath !== false && scope === "user";
  const supportsPath = entry.supportsPath !== false;
  const supportsSystemScope = entry.supportsSystemScope !== false;

  useEffect(() => {
    let active = true;
    setVersionsLoading(true);
    setVersionsError("");
    const request = window.devEnv?.versions(entry.id, source);
    if (!request) {
      setVersionsLoading(false);
      return () => { active = false; };
    }
    request.then((items) => {
      if (!active) return;
      setVersions(items);
      setVersion((old) => items.includes(old) ? old : items[0] || "");
    }).catch((error) => {
      if (!active) return;
      setVersions([]);
      setVersion("");
      setVersionsError(getErrorMessage(error));
    }).finally(() => {
      if (active) setVersionsLoading(false);
    });
    return () => { active = false; };
  }, [entry.id, entry.name, source, versionRetry]);

  useEffect(() => setSource(settings.sourceRegion), [settings.sourceRegion]);

  const pickDirectory = async () => {
    try {
      const chosen = await window.devEnv?.pickDirectory();
      if (chosen) setCustomPath(chosen);
    } catch (error) {
      reportError("选择目录失败", error);
    }
  };

  const submitInstall = async () => {
    if (!window.devEnv || !version) return;
    const request: InstallRequest = {
      id: entry.id,
      version,
      scope,
      path: supportsCustomPath && customPath.trim() ? customPath.trim() : undefined,
      addToPath: supportsPath && addToPath,
      source,
      ...(entry.id === "node" ? { withTypeScript } : {}),
    };
    setBusy(true);
    try {
      await window.devEnv.install(request);
      setInstallOpen(false);
      await refresh();
      addToast({ title: `${meta.label} 已加入安装任务`, color: "success", timeout: 2500 });
    } catch (error) {
      reportError("无法创建安装任务", error);
    } finally {
      setBusy(false);
    }
  };

  const runInstallationAction = async () => {
    if (!window.devEnv || !pendingAction) return;
    const { kind, installation } = pendingAction;
    setBusy(true);
    try {
      await window.devEnv[kind](installation.installationId);
      setPendingAction(null);
      await refresh();
      addToast({ title: kind === "activate" ? "已切换活动版本" : kind === "update" ? "更新已加入任务" : "已卸载", color: "success", timeout: 2500 });
    } catch (error) {
      reportError(kind === "activate" ? "切换失败" : kind === "update" ? "更新失败" : "卸载失败", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
      <div className="dev-detail-grid">
        <section className="min-w-0">
          <h3 className="dev-section-heading">已发现的版本 <span className="text-default-400 font-normal">{installed.length}</span></h3>
          {installed.length === 0 ? <p className="dev-muted py-5">尚未在此电脑上发现 {meta.label}。</p> : (
            <div className="divide-y divide-divider">
              {installed.map((item) => (
                <div key={item.installationId || `${item.id}-${item.version}-${item.path}`} className="py-3 first:pt-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-jetbrains text-sm font-semibold">{item.version}</span>
                    {item.active && <Chip color="success" size="sm" variant="flat">当前</Chip>}
                    {item.updateAvailable && <Chip color="warning" size="sm" variant="flat">有新版本</Chip>}
                    {!item.managed && item.updateable && <Chip color="default" size="sm" variant="flat">可由原渠道更新</Chip>}
                    <span className="text-xs text-default-400">{formatOrigin(item)} · {item.scope === "system" ? "全系统" : "当前用户"}</span>
                  </div>
                  <p className="mt-1 break-all font-jetbrains text-xs text-default-400">{item.path || "路径不可用"}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.managed && !item.active && <Button size="sm" variant="flat" radius="sm" startContent={<Check size={14} />} onPress={() => setPendingAction({ kind: "activate", installation: item })}>设为当前</Button>}
                    {(item.updateAvailable || item.updateable) && <Button size="sm" variant="flat" radius="sm" startContent={<ArrowUpCircle size={14} />} onPress={() => setPendingAction({ kind: "update", installation: item })}>{item.updateable && !item.updateAvailable ? "由原渠道更新" : "更新"}</Button>}
                    {item.managed && <Button size="sm" variant="light" color="danger" radius="sm" startContent={<Trash2 size={14} />} onPress={() => setPendingAction({ kind: "uninstall", installation: item })}>卸载</Button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="min-w-0 md:border-l md:border-divider md:pl-5">
          <h3 className="dev-section-heading">安装新版本</h3>
          <div className="mt-3 grid gap-3">
            <Select label="版本" labelPlacement="outside" placeholder={versionsLoading ? "正在获取版本" : "选择版本"} selectedKeys={version ? new Set([version]) : new Set()} onSelectionChange={(keys) => { if (keys instanceof Set) setVersion(String([...keys][0] || "")); }} isDisabled={versionsLoading || versions.length === 0} size="sm" variant="bordered" classNames={{ trigger: "!rounded-md" }}>
              {versions.map((item) => <SelectItem key={item}>{displayVersion(item)}</SelectItem>)}
            </Select>
            {versionsError && <div className="dev-version-error">
              <strong>获取 {meta.label} 版本失败</strong>
              <p>当前源请求失败：{versionsError}</p>
              {entry.mirrorAvailable !== false && <div className="dev-version-error-actions">
                <Button size="sm" color="primary" radius="sm" onPress={() => setSource(source === "china" ? "international" : "china")}>确认切换到{regionLabels[source === "china" ? "international" : "china"]}</Button>
                <Button size="sm" variant="flat" radius="sm" onPress={() => setVersionRetry((value) => value + 1)}>重试当前源</Button>
              </div>}
            </div>}
            <div>
              <span className="dev-field-label">安装范围</span>
              <div className="dev-segment mt-2" role="group" aria-label="安装范围">
                <button className={scope === "user" ? "active" : ""} onClick={() => setScope("user")}>当前用户</button>
                <button className={scope === "system" ? "active" : ""} disabled={!supportsSystemScope} onClick={() => { setScope("system"); setCustomPath(""); }}>全系统</button>
              </div>
            </div>
            {supportsCustomPath && <div>
              <span className="dev-field-label">安装目录 <span className="font-normal text-default-400">留空使用默认位置</span></span>
              <div className="mt-2 flex gap-2">
                <Input aria-label="自定义安装目录" size="sm" variant="bordered" radius="sm" value={customPath} onValueChange={setCustomPath} placeholder="选择或输入目录" classNames={{ input: "font-jetbrains text-xs" }} />
                <Tooltip content="选择目录"><Button isIconOnly aria-label="选择目录" size="sm" variant="flat" radius="sm" onPress={pickDirectory}><FolderOpen size={17} /></Button></Tooltip>
              </div>
            </div>}
            <Select label="下载源" labelPlacement="outside" size="sm" variant="bordered" selectedKeys={new Set([source])} onSelectionChange={(keys) => { if (keys instanceof Set) setSource(String([...keys][0]) as SourceRegion); }} classNames={{ trigger: "!rounded-md" }}>
              {(Object.keys(regionLabels) as SourceRegion[]).map((key) => <SelectItem key={key}>{regionLabels[key]}</SelectItem>)}
            </Select>
            <p className="dev-source-hint">当前策略：{entry.mirrorAvailable === false ? "仅使用官方源" : regionDetails[source]}</p>
            {entry.mirrorAvailable === false && <p className="dev-muted -mt-1">此环境没有可靠的地区镜像，三种选择都会使用官方源。</p>}
            {supportsPath && <Switch size="sm" isSelected={addToPath} onValueChange={setAddToPath}>加入 PATH</Switch>}
            {entry.id === "node" && <Switch size="sm" isSelected={withTypeScript} onValueChange={setWithTypeScript}>同时安装 TypeScript</Switch>}
            {(entry.id === "kotlin" || entry.id === "scala") && <p className="dev-muted">安装任务会自动检查并准备 JDK。</p>}
            {(entry.id === "cpp" || entry.id === "lua") && <p className="dev-muted">此环境使用 MSYS2 工具链。</p>}
            <Button color="primary" radius="sm" startContent={<Plus size={16} />} isDisabled={!version || !window.devEnv} onPress={() => setInstallOpen(true)}>加入安装任务</Button>
          </div>
        </section>
      </div>

      <Modal isOpen={installOpen} onOpenChange={setInstallOpen} size="lg">
        <ModalContent>
          {(onClose) => <>
            <ModalHeader>确认安装 {meta.label} {displayVersion(version)}</ModalHeader>
            <ModalBody className="text-sm">
              <div className="dev-preview-row"><span>安装范围</span><strong>{scope === "system" ? "全系统（需要管理员授权）" : "当前用户"}</strong></div>
              <div className="dev-preview-row"><span>安装目录</span><strong className="break-all">{supportsCustomPath && customPath.trim() ? customPath.trim() : "默认目录"}</strong></div>
              <div className="dev-preview-row"><span>下载源</span><strong>{regionLabels[source]}</strong></div>
              <div className="dev-preview-row"><span>环境变量</span><strong>{supportsPath && addToPath ? "添加到 PATH；原值会备份" : "不修改 PATH"}</strong></div>
              {withTypeScript && entry.id === "node" && <div className="dev-preview-row"><span>附加组件</span><strong>TypeScript</strong></div>}
            </ModalBody>
            <ModalFooter><Button variant="light" onPress={onClose}>取消</Button><Button color="primary" isLoading={busy} onPress={submitInstall}>确认并开始</Button></ModalFooter>
          </>}
        </ModalContent>
      </Modal>

      <Modal isOpen={Boolean(pendingAction)} onOpenChange={(open) => { if (!open) setPendingAction(null); }} size="md">
        <ModalContent>
          {(onClose) => <>
            <ModalHeader>{pendingAction?.kind === "activate" ? "切换活动版本" : pendingAction?.kind === "update" ? "更新环境" : "卸载环境"}</ModalHeader>
            <ModalBody className="text-sm text-default-600">
              <p>{meta.label} {pendingAction?.installation.version}</p>
              <p className="break-all font-jetbrains text-xs">{pendingAction?.installation.path}</p>
              <p>{pendingAction?.kind === "activate" ? "将更新此环境的活动版本和 PATH；原设置会备份。" : pendingAction?.kind === "uninstall" ? "将移除本工具安装的该版本，并恢复相关环境变量。" : "将通过原安装来源检查并安装可用更新。"}</p>
              {pendingAction?.installation.scope === "system" && <p>全系统操作需要管理员授权。</p>}
            </ModalBody>
            <ModalFooter><Button variant="light" onPress={onClose}>取消</Button><Button color={pendingAction?.kind === "uninstall" ? "danger" : "primary"} isLoading={busy} onPress={runInstallationAction}>确认</Button></ModalFooter>
          </>}
        </ModalContent>
      </Modal>
    </motion.div>
  );
}

export default function DevEnvironments() {
  const { apiAvailable, catalog, installations, jobs, loading, refresh } = useDevEnv();
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("全部");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const catalogById = useMemo(() => new Map(catalog.map((item) => [item.id, item])), [catalog]);
  const visible = languages.filter((item) => (group === "全部" || item.group === group) && `${item.label} ${item.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  const activeCount = installations.filter((item) => item.active).length;
  const taskCount = jobs.filter((item) => ["queued", "running", "paused"].includes(item.status)).length;

  const doRefresh = async () => {
    setRefreshing(true);
    try { await refresh(); } finally { setRefreshing(false); }
  };

  return <div className="dev-page">
    <div className="dev-page-head">
      <div><span className="dev-eyebrow">DEVELOPMENT RUNTIMES</span><h1>环境</h1><p>管理此电脑上的语言运行时和开发工具链</p></div>
      <Tooltip content="重新扫描环境"><Button isIconOnly aria-label="重新扫描环境" variant="flat" radius="sm" isLoading={refreshing} onPress={doRefresh}><RefreshCw size={17} /></Button></Tooltip>
    </div>

    {!apiAvailable && <div className="dev-notice"><Info size={17} /><span>安装与扫描需要在 Electron 桌面窗口中运行。</span></div>}

    <div className="dev-stats">
      <span><strong>{installations.length}</strong><small>已发现版本</small></span>
      <span><strong>{activeCount}</strong><small>活动环境</small></span>
      <span><strong>{taskCount}</strong><small>进行中任务</small></span>
    </div>

    <div className="dev-toolbar">
      <div className="dev-filters" role="group" aria-label="环境分类">
        {["全部", "常用", "语言", "工具链", "JVM"].map((item) => <button key={item} className={group === item ? "active" : ""} onClick={() => setGroup(item)}>{item}</button>)}
      </div>
      <Input aria-label="搜索环境" placeholder="搜索环境" startContent={<Search size={16} />} size="sm" variant="bordered" radius="sm" value={query} onValueChange={setQuery} className="w-full sm:max-w-52" />
    </div>

    <div className="dev-list" aria-busy={loading}>
      {visible.length === 0 ? <p className="dev-empty">没有符合条件的环境。</p> : visible.map((meta) => {
        const found = installations.filter((item) => item.id === meta.id);
        const active = found.find((item) => item.active);
        const entry = catalogById.get(meta.id) || { id: meta.id, name: meta.label, description: meta.description };
        const expanded = expandedId === meta.id;
        return <div className="dev-list-item" key={meta.id}>
          <button className="dev-list-trigger" aria-expanded={expanded} onClick={() => setExpandedId(expanded ? null : meta.id)}>
            <span className="dev-language-logo" style={{ "--mark-color": meta.tint }} aria-hidden="true">{meta.mark}</span>
            <span className="min-w-0 flex-1 text-left"><strong>{meta.label}</strong><small>{entry.description || meta.description}</small></span>
            <span className="dev-list-version hidden shrink-0 text-right sm:block">{active ? <span className="font-jetbrains text-sm text-foreground">{active.version}</span> : <span className="text-sm text-default-400">未安装</span>}{found.length > 1 && <small>{found.length} 个版本</small>}</span>
            {found.some((item) => item.updateAvailable || item.updateable) && <span className="dev-update-dot" title="有更新或原渠道更新能力" />}
            <ChevronDown className={`shrink-0 text-default-400 transition-transform ${expanded ? "rotate-180" : ""}`} size={17} />
          </button>
          <AnimatePresence initial={false}>{expanded && <EnvironmentDetails key={meta.id} entry={entry} meta={meta} installed={found} />}</AnimatePresence>
        </div>;
      })}
    </div>
    <p className="dev-footer-note">外部安装可供检测；由原安装器管理的环境会按其来源更新。</p>
  </div>;
}
