import React from "react";
import ReactDOM from "react-dom/client";
import { AuthGate } from "./AuthGate";
import "@xyflow/react/dist/style.css";
import "./index.css";
import { AuthProvider } from "./auth/AuthContext";
import { AppErrorBoundary } from "./components/AppErrorBoundary";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
