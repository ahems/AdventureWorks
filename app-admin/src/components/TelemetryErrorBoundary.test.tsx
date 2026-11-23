import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { TelemetryErrorBoundary } from "./TelemetryErrorBoundary";
const telemetry = vi.hoisted(() => ({ trackException: vi.fn() }));
vi.mock("@/lib/appInsights", () => telemetry);

it("contains React render failure and reports once without exposing error text in the fallback", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const failure = new Error("private-marker");
  const Broken = () => { throw failure; };
  render(<TelemetryErrorBoundary><Broken /></TelemetryErrorBoundary>);
  expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private-marker");
  expect(telemetry.trackException).toHaveBeenCalledTimes(1);
  expect(telemetry.trackException).toHaveBeenCalledWith(failure, { operation: "react-render" });
  vi.restoreAllMocks();
});
