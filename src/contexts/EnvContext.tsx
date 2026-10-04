import { createContext, useContext } from "react";

interface EnvContextType {
  isDesktop: boolean;
  isWeb: boolean;
}

const EnvContext = createContext<EnvContextType>({ isDesktop: false, isWeb: true });

export function EnvProvider({ children }: { children: React.ReactNode }) {
  const isDesktop = Boolean(window.devEnv);
  return <EnvContext.Provider value={{ isDesktop, isWeb: !isDesktop }}>{children}</EnvContext.Provider>;
}

export const useEnv = () => useContext(EnvContext);
