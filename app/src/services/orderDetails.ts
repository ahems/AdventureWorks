import { z } from "zod";
import { getFunctionsApiUrl } from "@/lib/utils";
import { functionsFetch } from "@/services/functionsAuth";

const orderDetailSchema = z.object({
  salesOrderId: z.number().int().positive(),
  productId: z.number().int().positive(),
  orderQty: z.number().int().positive(),
  unitPrice: z.number(),
  unitPriceDiscount: z.number(),
  lineTotal: z.number(),
  productName: z.string(),
}).strict();

export type OwnedOrderDetail = z.infer<typeof orderDetailSchema>;

export async function fetchOwnedOrderDetails(orderIds: number[]): Promise<OwnedOrderDetail[]> {
  if (orderIds.length === 0) return [];
  if (
    orderIds.length > 100 ||
    new Set(orderIds).size !== orderIds.length ||
    orderIds.some(id => !Number.isInteger(id) || id <= 0 || id > 2147483647)
  ) {
    throw new Error("Order IDs must be distinct positive integers within the batch limit.");
  }

  const query = new URLSearchParams({ orderIds: orderIds.join(",") });
  const response = await functionsFetch(`${getFunctionsApiUrl()}/api/orders/details?${query}`);
  if (!response.ok) {
    throw new Error(`Failed to load order details (HTTP ${response.status}).`);
  }
  const details = z.array(orderDetailSchema).parse(await response.json());
  const requested = new Set(orderIds);
  if (details.some(detail => !requested.has(detail.salesOrderId))) {
    throw new Error("Order details included an unrequested order.");
  }
  return details;
}
