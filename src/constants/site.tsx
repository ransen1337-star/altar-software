import { CodeXml, Globe2, Info, ListTodo } from "lucide-react";
import type { NavItem } from "@/types/nav";

export type SocialInfo = { qqGroupNumber: string; qqGroupLink: string; githubStars: string };
export type SiteConfig = typeof siteConfig;

export const siteConfig = {
  name: "Altar",
  description: "Altar Windows 开发环境管理器",
  sidebarNavItems: [
    { key: "environments", label: "环境", icon: <CodeXml size={21} strokeWidth={1.8} />, href: "/" },
    { key: "jobs", label: "安装任务", icon: <ListTodo size={21} strokeWidth={1.8} />, href: "/jobs" },
    { key: "sources", label: "源与设置", icon: <Globe2 size={21} strokeWidth={1.8} />, href: "/sources" },
    { key: "about", label: "关于", icon: <Info size={21} strokeWidth={1.8} />, href: "/about", position: "bottom" },
  ] as NavItem[],
  links: {
    github: "https://github.com/",
    bilibili: "https://space.bilibili.com/629593183",
    download: "https://github.com/",
  },
  socialInfo: {
    qqGroupNumber: "150453391",
    qqGroupLink: "https://qm.qq.com/q/hWUZ7bzdS2",
    githubStars: "500",
  } satisfies SocialInfo,
};
