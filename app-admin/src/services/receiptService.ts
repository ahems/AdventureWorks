import { getFunctionsApiUrl } from "@/lib/utils";

export async function downloadReceipt(salesOrderId: number): Promise<void> {
  // The installed Functions fetch interceptor supplies the resource-bound token.
  const response = await fetch(
    `${getFunctionsApiUrl()}/api/orders/${salesOrderId}/receipt`,
  );
  if (!response.ok) {
    throw new Error(`Receipt download failed (HTTP ${response.status}).`);
  }
  if (response.headers.get("Content-Type")?.split(";")[0].trim() !== "application/pdf") {
    throw new Error("The receipt service did not return a PDF.");
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `receipt-SO${salesOrderId}.pdf`;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Let the browser consume the download before releasing the temporary URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
