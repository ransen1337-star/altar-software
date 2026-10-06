import { useEffect, useState } from "react";
import { Button } from "@heroui/button";
import { Switch } from "@heroui/switch";
import { Select, SelectItem } from "@heroui/select";
import { Input } from "@heroui/input";
import { Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from "@heroui/modal";
import { Globe2, Save, ShieldCheck } from "lucide-react";
import { useDevEnv } from "../DevEnvContext";
import type { DevSettings, LogLevel, SourceRegion } from "../types";

const regionOptions: { key: SourceRegion; name: string; detail: string }[] = [
  { key: "auto", name: "自动", detail: "官方源优先，失败时回退镜像" },
  { key: "china", name: "中国大陆", detail: "地区镜像优先，失败时回退官方源" },
  { key: "international", name: "国际", detail: "仅使用官方国际下载地址" },
];

const registries: { key: keyof DevSettings["registryMirrors"]; name: string; note: string }[] = [
  { key: "pip", name: "pip", note: "Python 包索引" },
  { key: "npm", name: "npm", note: "Node.js 包注册表" },
  { key: "maven", name: "Maven", note: "Java 依赖仓库" },
  { key: "cargo", name: "Cargo", note: "Rust crate 索引" },
  { key: "go", name: "Go", note: "Go 模块代理" },
];

const logLevels: { key: LogLevel; name: string; detail: string }[] = [
  { key: "error", name: "仅错误", detail: "只记录失败、拒绝和校验错误" },
  { key: "normal", name: "标准", detail: "记录安装阶段和关键结果" },
  { key: "verbose", name: "详细", detail: "保留下载器和安装器输出" },
  { key: "debug", name: "Debug", detail: "记录请求、响应和文件操作上下文" },
  { key: "trace", name: "Trace", detail: "记录分片、速度、哈希和完整堆栈" },
];

export default function DevSources() {
  const { settings, saveSettings, apiAvailable } = useDevEnv();
  const [draft, setDraft] = useState<DevSettings>(settings);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(settings), [settings]);
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);
  const changedRegistries = registries.filter((item) => draft.registryMirrors[item.key] !== settings.registryMirrors[item.key]);

  const save = async () => {
    setBusy(true);
    try {
      await saveSettings(draft);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return <div className="dev-page">
    <div className="dev-page-head"><div><h1>源与设置</h1><p>选择环境下载地址和包仓库配置</p></div></div>
    <div className="dev-settings-card-grid">
    <section className="dev-settings-section dev-settings-card">
      <div className="dev-section-intro"><ShieldCheck size={19} /><div><h2>下载日志</h2><p>控制安装任务页面显示和保存的日志详细程度。</p></div></div>
      <Select label="日志级别" labelPlacement="outside" size="sm" variant="bordered" selectedKeys={new Set([draft.logLevel])} onSelectionChange={(keys) => { if (keys === "all") return; const [value] = [...keys]; if (value) setDraft((current) => ({ ...current, logLevel: String(value) as LogLevel })); }} classNames={{ trigger: "!rounded-md" }}>
        {logLevels.map((level) => <SelectItem key={level.key} description={level.detail}>{level.name}</SelectItem>)}
      </Select>
    </section>

    <section className="dev-settings-section dev-settings-card">
      <div className="dev-section-intro"><Globe2 size={19} /><div><h2>环境下载源</h2><p>应用到新建的安装任务；已有任务继续使用创建时的地址。</p></div></div>
      <Input label="GitHub 镜像仓库地址" labelPlacement="outside" size="sm" variant="bordered" placeholder="https://raw.githubusercontent.com/ransen1337-star/altar-git-mirror/main" value={draft.mirrorBaseUrl} onValueChange={(value) => setDraft({ ...draft, mirrorBaseUrl: value })} description="默认使用 Altar GitHub 镜像；修改后会优先从新的 raw 地址读取版本和安装包。" classNames={{ inputWrapper: "!rounded-md" }} />
      <div className="dev-region-grid">
        {regionOptions.map((option) => <button key={option.key} className={`dev-region-option ${draft.sourceRegion === option.key ? "selected" : ""}`} onClick={() => setDraft({ ...draft, sourceRegion: option.key })} aria-pressed={draft.sourceRegion === option.key}>
          <span className="dev-radio-indicator" /><strong>{option.name}</strong><small>{option.detail}</small>
        </button>)}
      </div>
      <p className="dev-muted mt-3">没有可靠地区镜像的环境始终使用官方源；下载前仍会校验官方哈希或签名。</p>
    </section>

    <section className="dev-settings-section dev-settings-card">
      <div className="dev-section-intro"><ShieldCheck size={19} /><div><h2>包仓库镜像</h2><p>单独配置包管理器。更改下载地区不会自动修改这些选项。</p></div></div>
      <div className="dev-registry-list">
        {registries.map((registry) => <div key={registry.key} className="dev-registry-row"><div><strong>{registry.name}</strong><small>{registry.note}</small></div><Switch aria-label={`${registry.name} 镜像`} size="sm" isSelected={draft.registryMirrors[registry.key]} onValueChange={(value) => setDraft({ ...draft, registryMirrors: { ...draft.registryMirrors, [registry.key]: value } })} /></div>)}
      </div>
    </section>

    </div>
    <div className="dev-settings-actions"><Button variant="light" radius="sm" isDisabled={!changed} onPress={() => setDraft(settings)}>放弃修改</Button><Button color="primary" radius="sm" startContent={<Save size={16} />} isDisabled={!changed || !apiAvailable} onPress={() => setOpen(true)}>保存设置</Button></div>

    <Modal isOpen={open} onOpenChange={setOpen} size="md"><ModalContent>{(onClose) => <><ModalHeader>确认配置变更</ModalHeader><ModalBody className="text-sm text-default-600">
      {draft.sourceRegion !== settings.sourceRegion && <p>环境下载源：{regionOptions.find((option) => option.key === settings.sourceRegion)?.name} → {regionOptions.find((option) => option.key === draft.sourceRegion)?.name}</p>}
      {draft.mirrorBaseUrl !== settings.mirrorBaseUrl && <p>GitHub 镜像仓库：{draft.mirrorBaseUrl || "停用"}</p>}
      {changedRegistries.map((item) => <p key={item.key}>{item.name}：{draft.registryMirrors[item.key] ? "启用地区镜像" : "恢复默认源"}</p>)}
      {changedRegistries.length > 0 && <p>包管理器配置会先备份；写入失败时恢复原配置。</p>}
    </ModalBody><ModalFooter><Button variant="light" onPress={onClose}>取消</Button><Button color="primary" isLoading={busy} onPress={save}>确认保存</Button></ModalFooter></>}</ModalContent></Modal>
  </div>;
}
