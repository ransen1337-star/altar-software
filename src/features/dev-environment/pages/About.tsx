import { Button } from "@heroui/button";
import { ShieldCheck } from "lucide-react";
import brandMark from "@/assets/brand-mark.svg";

export default function DevAbout() {
  const openExternal = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

  return <div className="dev-page">
    <div className="dev-page-head"><div><h1>关于</h1><p>Altar Windows 开发环境管理器</p></div></div>
    <section className="dev-settings-section">
      <div className="dev-section-intro"><span className="dev-about-logo"><img src={brandMark} alt="" /></span><div><h2>Altar</h2><p>统一查看、安装和切换此电脑上的开发环境。</p></div></div>
      <div className="dev-about-grid"><div><span>平台</span><strong>Windows 10+ x64</strong></div><div><span>桌面技术</span><strong>Electron · React · TypeScript</strong></div><div><span>许可</span><strong>AGPL-3.0</strong></div></div>
    </section>
    <section className="dev-settings-section">
      <div className="dev-section-intro"><ShieldCheck size={19} /><div><h2>开源与许可</h2><p>本项目按仓库中的 AGPL-3.0 许可证提供。</p></div></div>
      <p className="dev-muted mt-3">第三方依赖和致谢信息请参阅项目 README。</p>
    </section>
  </div>;
}
