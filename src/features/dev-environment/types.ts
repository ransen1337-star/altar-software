export type SourceRegion = "auto" | "china" | "international";
export type InstallScope = "user" | "system";
export type LogLevel = "error" | "normal" | "verbose";

export interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  category?: string;
  installMethod?: string;
  mirrorAvailable?: boolean;
  supportsCustomPath?: boolean;
  supportsSystemScope?: boolean;
  supportsPath?: boolean;
}

export interface Installation {
  id: string;
  installationId: string;
  version: string;
  path: string;
  source: string;
  managed: boolean;
  scope: InstallScope;
  active: boolean;
  updateAvailable?: boolean;
  updateable?: boolean;
}

export type JobStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface InstallJob {
  id: string;
  languageId: string;
  version: string;
  status: JobStatus;
  progress: number;
  stage?: string;
  logs?: string[];
  error?: string;
  awaitingConfirmation?: boolean;
  sourceConfirmation?: {
    failedUrl: string;
    nextUrl: string;
    error: string;
  };
}

export interface DevSettings {
  sourceRegion: SourceRegion;
  logLevel: LogLevel;
  mirrorBaseUrl: string;
  registryMirrors: {
    pip: boolean;
    npm: boolean;
    maven: boolean;
    cargo: boolean;
    go: boolean;
  };
}

export interface InstallRequest {
  id: string;
  version: string;
  scope: InstallScope;
  path?: string;
  addToPath: boolean;
  source: SourceRegion;
  withTypeScript?: boolean;
}

export interface DevEnvApi {
  catalog(): Promise<CatalogEntry[]>;
  scan(): Promise<Installation[]>;
  versions(id: string, source?: SourceRegion): Promise<string[]>;
  jobs(): Promise<InstallJob[]>;
  install(request: InstallRequest): Promise<unknown>;
  activate(installationId: string): Promise<unknown>;
  uninstall(installationId: string): Promise<unknown>;
  update(installationId: string): Promise<unknown>;
  pause(jobId: string): Promise<unknown>;
  resume(jobId: string): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  confirmSource(jobId: string, accept: boolean): Promise<unknown>;
  removeJob(jobId: string): Promise<unknown>;
  getSettings(): Promise<DevSettings>;
  setSettings(settings: Partial<DevSettings>): Promise<unknown>;
  pickDirectory(): Promise<string | null>;
  onChange(callback: (change: { type?: string } | string) => void): (() => void) | void;
  windowAction(action: "minimize" | "maximize" | "close"): Promise<unknown>;
  windowState(): Promise<{ maximized?: boolean; isMaximized?: boolean; fullscreen?: boolean; isFullscreen?: boolean }>;
}

declare global {
  interface Window {
    devEnv?: DevEnvApi;
  }
}
