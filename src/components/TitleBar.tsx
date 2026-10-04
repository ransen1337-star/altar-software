import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

interface TitleBarProps {
  autoHide?: boolean;
  hasBackground?: boolean;
  title?: string;
  icon?: string;
}

export function TitleBar({ title = "Altar", icon }: TitleBarProps) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const check = () => {
      const request = window.devEnv?.windowState();
      request?.then((state) => setMaximized(Boolean(state.maximized ?? state.isMaximized))).catch(() => {});
    };
    void check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const action = async (kind: "minimize" | "maximize" | "close") => {
    await window.devEnv?.windowAction(kind);
    if (kind === "maximize") {
      const state = await window.devEnv?.windowState();
      setMaximized(Boolean(state?.maximized ?? state?.isMaximized));
    }
  };

  return <div className="dev-titlebar">
    <div className="dev-titlebar-caption">{icon && <img src={icon} alt="" />}<span>{title}</span></div>
    <div className="dev-window-buttons">
      <button aria-label="最小化" title="最小化" onClick={() => void action("minimize")}><Minus size={15} /></button>
      <button aria-label={maximized ? "还原" : "最大化"} title={maximized ? "还原" : "最大化"} onClick={() => void action("maximize")}>{maximized ? <Copy size={13} /> : <Square size={13} />}</button>
      <button aria-label="关闭" title="关闭" className="close" onClick={() => void action("close")}><X size={15} /></button>
    </div>
  </div>;
}

export default TitleBar;
