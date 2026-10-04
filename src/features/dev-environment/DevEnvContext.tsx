import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { addToast } from "@heroui/toast";
import type { CatalogEntry, DevSettings, InstallJob, Installation } from "./types";

const defaultSettings: DevSettings = {
  sourceRegion: "auto",
  logLevel: "normal",
  mirrorBaseUrl: "",
  registryMirrors: { pip: false, npm: false, maven: false, cargo: false, go: false },
};

type DevEnvContextValue = {
  apiAvailable: boolean;
  loading: boolean;
  catalog: CatalogEntry[];
  installations: Installation[];
  jobs: InstallJob[];
  settings: DevSettings;
  refresh: () => Promise<void>;
  refreshJobs: () => Promise<void>;
  saveSettings: (settings: Partial<DevSettings>) => Promise<void>;
};

const DevEnvContext = createContext<DevEnvContextValue | null>(null);

function reportError(title: string, error: unknown) {
  addToast({
    title,
    description: error instanceof Error ? error.message : String(error),
    color: "danger",
    timeout: 6000,
  });
}

export function DevEnvProvider({ children }: { children: React.ReactNode }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [jobs, setJobs] = useState<InstallJob[]>([]);
  const [settings, setSettings] = useState<DevSettings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const apiAvailable = Boolean(window.devEnv);

  const refreshJobs = useCallback(async () => {
    if (!window.devEnv) return;
    try {
      setJobs(await window.devEnv.jobs());
    } catch (error) {
      reportError("读取安装任务失败", error);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!window.devEnv) {
      setLoading(false);
      return;
    }
    const results = await Promise.allSettled([
      window.devEnv.catalog(),
      window.devEnv.scan(),
      window.devEnv.jobs(),
      window.devEnv.getSettings(),
    ]);
    if (results[0].status === "fulfilled") setCatalog(results[0].value);
    if (results[1].status === "fulfilled") setInstallations(results[1].value);
    if (results[2].status === "fulfilled") setJobs(results[2].value);
    if (results[3].status === "fulfilled") setSettings(results[3].value);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") reportError("加载环境数据失败", failed.reason);
    setLoading(false);
  }, []);

  const saveSettings = useCallback(async (next: Partial<DevSettings>) => {
    if (!window.devEnv) return;
    try {
      await window.devEnv.setSettings(next);
      setSettings(await window.devEnv.getSettings());
      addToast({ title: "设置已保存", color: "success", timeout: 2200 });
    } catch (error) {
      reportError("保存设置失败", error);
      throw error;
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    const unsubscribe = window.devEnv?.onChange((change) => {
      if (typeof change === "object" && change?.type === "jobs") {
        void refreshJobs();
      } else {
        void refresh();
      }
    });
    const timer = window.setInterval(() => void refreshJobs(), 2500);
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
      window.clearInterval(timer);
    };
  }, [refresh, refreshJobs]);

  const value = useMemo(
    () => ({ apiAvailable, loading, catalog, installations, jobs, settings, refresh, refreshJobs, saveSettings }),
    [apiAvailable, loading, catalog, installations, jobs, settings, refresh, refreshJobs, saveSettings],
  );

  return <DevEnvContext.Provider value={value}>{children}</DevEnvContext.Provider>;
}

export function useDevEnv() {
  const context = useContext(DevEnvContext);
  if (!context) throw new Error("DevEnvProvider is missing");
  return context;
}

export { reportError };
