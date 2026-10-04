import { memo, useCallback, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Menu, X } from "lucide-react";
import { Button } from "@heroui/button";
import { siteConfig } from "@/constants/site";
import type { NavItem } from "@/types/nav";
import brandMark from "@/assets/brand-mark.svg";

const Navigation = memo(function Navigation({ close }: { close: () => void }) {
  const { pathname } = useLocation();
  const render = (item: NavItem) => <Link key={item.key} to={item.href} onClick={close} className={`dev-nav-link ${pathname === item.href ? "active" : ""}`} aria-current={pathname === item.href ? "page" : undefined}>
    <span className="shrink-0">{item.icon}</span><span>{item.label}</span>
  </Link>;
  return <nav className="flex h-full flex-col" aria-label="主导航">
    <div className="flex flex-col gap-1">{siteConfig.sidebarNavItems.filter((item) => item.position !== "bottom").map(render)}</div>
    <div className="flex-1" />
    <div className="flex flex-col gap-1">{siteConfig.sidebarNavItems.filter((item) => item.position === "bottom").map(render)}</div>
  </nav>;
});

export function Sidebar() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return <>
    <div className="dev-mobile-header md:hidden">
      <Link to="/" className="dev-mobile-brand" onClick={close}><img src={brandMark} alt="" /><span>Altar</span></Link>
      <Button isIconOnly variant="light" size="sm" aria-label={open ? "关闭导航" : "打开导航"} onPress={() => setOpen((value) => !value)}>{open ? <X size={19} /> : <Menu size={19} />}</Button>
    </div>
    <div className="hidden h-full md:block">
      <div className="flex h-full w-72 flex-col border-r border-divider p-6">
        <Navigation close={close} />
      </div>
    </div>
    <div className={`dev-mobile-sidebar md:hidden ${open ? "open" : ""}`}><Navigation close={close} /></div>
    {open && <button className="dev-mobile-scrim md:hidden" aria-label="关闭导航" onClick={close} />}
  </>;
}
