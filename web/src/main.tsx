import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Root } from "./Root";
import "./styles.css";

class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, font: "13px/1.5 system-ui", color: "#b91c1c" }}>
          <h2>Something broke while rendering.</h2>
          <pre style={{ whiteSpace: "pre-wrap", background: "#fff1f2", padding: 12, borderRadius: 8 }}>
            {String(this.state.err?.stack ?? this.state.err)}
          </pre>
          <button onClick={() => this.setState({ err: null })}>retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </StrictMode>,
);
