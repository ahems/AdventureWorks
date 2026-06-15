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
import { fetchVendors, restockVendor } from "@/services/supplyChainApi";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { toast } from "sonner";

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

  const sorted = (vendors ?? [])
    .slice()
    .sort((a, b) => a.vendor.name.localeCompare(b.vendor.name));

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
            Use when one supplier has run dry during a demo and you want to keep
            procurement flowing without a full reset.
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
                    {v.vendor.name}
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
