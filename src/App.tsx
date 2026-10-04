import { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import DefaultLayout from "@/layouts/DefaultLayout";
import { DevEnvProvider } from "@/features/dev-environment/DevEnvContext";
import "@/features/dev-environment/styles.css";

const Environments = lazy(() => import("@/features/dev-environment/pages/Environments"));
const Jobs = lazy(() => import("@/features/dev-environment/pages/Jobs"));
const Sources = lazy(() => import("@/features/dev-environment/pages/Sources"));
const About = lazy(() => import("@/features/dev-environment/pages/About"));

export default function App() {
  return <DevEnvProvider>
    <Suspense fallback={<div className="dev-loading">正在加载...</div>}>
      <Routes>
        <Route element={<DefaultLayout />}>
          <Route path="/" element={<Environments />} />
          <Route path="/jobs" element={<Jobs />} />
          <Route path="/sources" element={<Sources />} />
          <Route path="/about" element={<About />} />
        </Route>
        <Route path="*" element={<Navigate replace to="/" />} />
      </Routes>
    </Suspense>
  </DevEnvProvider>;
}
