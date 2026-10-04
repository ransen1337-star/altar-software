import { useLocation } from "react-router-dom";
import { useEffect } from "react";

const titles: Record<string, string> = {
  "/": "环境",
  "/jobs": "安装任务",
  "/sources": "源与设置",
  "/about": "关于",
};

export function TitleUpdater() {
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = `${titles[pathname] || "环境"} | Altar`;
  }, [pathname]);

  return null;
}
