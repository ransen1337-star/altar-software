import { Outlet } from "react-router-dom";
import { Sidebar } from "@/components/Sidebar";
import TitleBar from "@/components/TitleBar";
import { useEnv } from "@/contexts/EnvContext";
import brandMark from "@/assets/brand-mark.svg";

export default function DefaultLayout() {
  const { isDesktop } = useEnv();
  return <>
    {isDesktop && <TitleBar hasBackground icon={brandMark} />}
    <div className="dark bg-background font-sans text-foreground antialiased min-h-screen">
      <div className={`dev-app-shell ${isDesktop ? "desktop" : ""}`}>
        <aside className="dev-sidebar"><Sidebar /></aside>
        <main className={`dev-main ${isDesktop ? "desktop" : ""}`}><Outlet /></main>
      </div>
    </div>
  </>;
}
