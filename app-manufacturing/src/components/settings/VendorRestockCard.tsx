import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import {
  fetchVendors,
  restockVendor,
  type VendorSummary,
} from "@/services/supplyChainApi";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { toast } from "sonner";

/** Stock health ratio (0 = fully depleted, 1 = fully stocked) */
function stockRatio(v: VendorSummary): number {
  return v.totalComponents > 0 ? v.inStockComponents / v.totalComponents : 1;
}

/** Sort: most depleted first, then fewest active orders (no help coming) */
function sortByNeed(a: VendorSummary, b: VendorSummary): number {
  const ratioA = stockRatio(a);
  const ratioB = stockRatio(b);
  if (ratioA !== ratioB) return ratioA - ratioB;
  // Same ratio — fewer active orders means more urgent
  if (a.activeOrders !== b.activeOrders) return a.activeOrders - b.activeOrders;
  return a.vendor.name.localeCompare(b.vendor.name);
}

/** Color class for the stock health dot */
function healthColor(v: VendorSummary): string {
  const ratio = stockRatio(v);
  if (ratio === 0) return "bg-red-500"; // completely out
  if (ratio < 0.5) return "bg-amber-500"; // low
  return "bg-emerald-500"; // healthy
}

/** Label shown next to vendor name */
function healthLabel(v: VendorSummary): string {
  const stock = `${v.inStockComponents}/${v.totalComponents} in stock`;
  if (v.activeOrders > 0) return `${stock} (${v.activeOrders} incoming)`;
  return stock;
}

export function VendorRestockCard() {
  const qc = useQueryClient();
  const [vendorId, setVendorId] = useState<string>("");
  const { data: vendors, isLoading } = useQuery({
    queryKey: ["supply-vendors"],
    queryFn: fetchVendors,
  });

  const mutation = useMutation({
    mutationFn: () => restockVendor(vendorId),
    onSuccess: () => {
      toast.success("Manual restock triggered");
      qc.invalidateQueries({ queryKey: ["supply-vendor", vendorId] });
      qc.invalidateQueries({ queryKey: ["supply-vendors"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sorted = (vendors ?? []).slice().sort(sortByNeed);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-doodle">Vendor Restock</CardTitle>
        <CardDescription>
          <p>
            Tops up a single vendor's available stock without resetting the rest
            of the supply chain. Other vendors and order history are untouched.
          </p>
          <p className="mt-1 text-xs italic">
            Vendors are sorted by urgency — most depleted with no incoming
            orders first.
          </p>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1 space-y-1">
            <label className="text-sm font-medium">Vendor</label>
            <Select
              value={vendorId}
              onValueChange={setVendorId}
              disabled={isLoading}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    isLoading ? "Loading vendors…" : "Select a vendor"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {sorted.map((v) => (
                  <SelectItem key={v.vendor.vendorId} value={v.vendor.vendorId}>
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full shrink-0 ${healthColor(v)}`}
                      />
                      <span className="truncate">{v.vendor.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
                        {healthLabel(v)}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => mutation.mutate()}
            disabled={!vendorId || mutation.isPending}
          >
            <RefreshCw
              className={`h-4 w-4 mr-1 ${mutation.isPending ? "animate-spin" : ""}`}
            />{" "}
            Restock Now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default VendorRestockCard;
