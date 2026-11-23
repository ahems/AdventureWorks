import { Component, type ReactNode } from "react";
import { trackException } from "@/lib/appInsights";

export class TelemetryErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { trackException(error, { operation: "react-render" }); }
  render() {
    return this.state.failed
      ? <main role="alert" className="p-8"><h1>Something went wrong</h1><p>This view could not be displayed.</p><a href="/">Return home</a></main>
      : this.props.children;
  }
}
