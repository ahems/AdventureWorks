import React from "react";
import { MapPin, Edit2, Trash2, Star } from "lucide-react";
import type { Address } from "@/hooks/useAddresses";
import { useTranslation } from "react-i18next";

interface AddressCardProps {
  address: Address;
  onEdit: (address: Address) => void;
  onDelete: (id: string) => void;
  onSetDefault: (id: string) => void;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (address: Address) => void;
}

export const AddressCard: React.FC<AddressCardProps> = ({
  address,
  onEdit,
  onDelete,
  onSetDefault,
  selectable = false,
  selected = false,
  onSelect,
}) => {
  const { t } = useTranslation("common");
  const handleClick = () => {
    if (selectable && onSelect) {
      onSelect(address);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`border-2 p-4 transition-all ${
        selectable ? "cursor-pointer hover:border-doodle-accent" : ""
      } ${
        selected
          ? "border-doodle-accent bg-doodle-accent/5"
          : "border-dashed border-doodle-text/20"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <MapPin className="w-5 h-5 text-doodle-accent flex-shrink-0 mt-0.5" />
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-doodle font-bold text-doodle-text">
                {address.addressType}
              </span>
              {address.isDefault && (
                <span className="font-doodle text-xs bg-doodle-accent text-white px-2 py-0.5 rounded">
                  {t("addressCard.default")}
                </span>
              )}
            </div>
            <p className="font-doodle text-sm text-doodle-text/70">
              {address.addressLine1}
            </p>
            {address.addressLine2 && (
              <p className="font-doodle text-sm text-doodle-text/70">
                {address.addressLine2}
              </p>
            )}
            <p className="font-doodle text-sm text-doodle-text/70">
              {address.city},{" "}
              {address.stateProvinceCode || address.stateProvinceId}{" "}
              {address.postalCode}
            </p>
            {address.countryName && (
              <p className="font-doodle text-sm text-doodle-text/70">
                {address.countryName}
              </p>
            )}
          </div>
        </div>

        {!selectable && (
          <div className="flex flex-col gap-2">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit(address);
              }}
              className="p-2 hover:bg-doodle-text/5 rounded transition-colors"
              title={t("addressCard.editAddress")}
            >
              <Edit2 className="w-4 h-4 text-doodle-text/70" />
            </button>
            {!address.isDefault && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSetDefault(address.id);
                }}
                className="p-2 hover:bg-doodle-text/5 rounded transition-colors"
                title={t("addressCard.setAsDefault")}
              >
                <Star className="w-4 h-4 text-doodle-text/70" />
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(t("addressCard.confirmDeleteAddress"))) {
                  onDelete(address.id);
                }
              }}
              className="p-2 hover:bg-doodle-accent/10 rounded transition-colors"
              title={t("addressCard.deleteAddress")}
            >
              <Trash2 className="w-4 h-4 text-doodle-accent" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
