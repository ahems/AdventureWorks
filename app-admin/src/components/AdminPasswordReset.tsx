import React, { useState } from "react";
import { KeyRound, Mail, Eye, EyeOff, Loader2, Check } from "lucide-react";
import { getFunctionsApiUrl } from "@/lib/utils";
import { toast } from "sonner";

interface AdminPasswordResetProps {
  businessEntityId: number;
  customerEmail: string;
}

export const AdminPasswordReset: React.FC<AdminPasswordResetProps> = ({
  businessEntityId,
  customerEmail,
}) => {
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const [showSetPassword, setShowSetPassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSetting, setIsSetting] = useState(false);
  const [errors, setErrors] = useState<{
    newPassword?: string;
    confirmPassword?: string;
  }>({});

  const handleSendResetEmail = async () => {
    if (!customerEmail) {
      toast.error("No email address on file for this customer");
      return;
    }
    setIsSendingEmail(true);
    try {
      const functionsUrl = getFunctionsApiUrl();
      const response = await fetch(
        `${functionsUrl}/api/password/reset/request`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: customerEmail }),
        },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setEmailSent(true);
      toast.success(`Password reset email sent to ${customerEmail}`);
    } catch {
      toast.error("Failed to send password reset email");
    } finally {
      setIsSendingEmail(false);
    }
  };

  const validateSetPassword = () => {
    const newErrors: typeof errors = {};
    if (newPassword.length < 8) {
      newErrors.newPassword = "Password must be at least 8 characters";
    }
    if (newPassword !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateSetPassword()) return;

    setIsSetting(true);
    try {
      const functionsUrl = getFunctionsApiUrl();
      const response = await fetch(`${functionsUrl}/api/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessEntityID: businessEntityId,
          Password: newPassword,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error?.error ?? `HTTP ${response.status}`);
      }

      toast.success("Password updated successfully");
      setNewPassword("");
      setConfirmPassword("");
      setShowSetPassword(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to set password";
      toast.error(message);
    } finally {
      setIsSetting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Send reset email */}
      <div className="flex items-start gap-4 p-4 bg-white border-2 border-doodle-text/10">
        <Mail className="w-5 h-5 text-gray-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-800">
            Send password reset email
          </p>
          <p className="text-xs text-gray-500 mt-0.5 break-all">
            Sends a reset link to{" "}
            <span className="font-medium">{customerEmail || "—"}</span>. The
            link expires in 1 hour.
          </p>
        </div>
        <button
          onClick={handleSendResetEmail}
          disabled={isSendingEmail || !customerEmail || emailSent}
          className="flex items-center gap-1.5 shrink-0 px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {isSendingEmail ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : emailSent ? (
            <Check className="w-4 h-4 text-green-600" />
          ) : (
            <Mail className="w-4 h-4" />
          )}
          {emailSent ? "Sent" : "Send Reset Email"}
        </button>
      </div>

      {/* Set new password */}
      <div className="p-4 bg-white border-2 border-doodle-text/10">
        <button
          onClick={() => setShowSetPassword((v) => !v)}
          className="flex items-center gap-2 text-sm font-medium text-gray-800 hover:text-blue-600 transition-colors w-full text-left"
        >
          <KeyRound className="w-4 h-4" />
          Set new password for this account
          <span className="ml-auto text-xs text-gray-400">
            {showSetPassword ? "▲" : "▼"}
          </span>
        </button>

        {showSetPassword && (
          <form onSubmit={handleSetPassword} className="mt-4 space-y-3">
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded px-3 py-2">
              This will immediately change the customer's password. Only use
              this if requested by the customer or for account recovery.
            </p>

            {/* New password */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                New Password
              </label>
              <div className="relative">
                <input
                  type={showNew ? "text" : "password"}
                  value={newPassword}
                  onChange={(e) => {
                    setNewPassword(e.target.value);
                    setErrors((prev) => ({ ...prev, newPassword: undefined }));
                  }}
                  className="w-full border border-gray-300 rounded-md px-3 py-1.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowNew((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showNew ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {errors.newPassword && (
                <p className="text-red-500 text-xs mt-1">
                  {errors.newPassword}
                </p>
              )}
            </div>

            {/* Confirm password */}
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Confirm New Password
              </label>
              <div className="relative">
                <input
                  type={showConfirm ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setErrors((prev) => ({
                      ...prev,
                      confirmPassword: undefined,
                    }));
                  }}
                  className="w-full border border-gray-300 rounded-md px-3 py-1.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  tabIndex={-1}
                >
                  {showConfirm ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
              {errors.confirmPassword && (
                <p className="text-red-500 text-xs mt-1">
                  {errors.confirmPassword}
                </p>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="submit"
                disabled={isSetting}
                className="flex items-center gap-1.5 bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {isSetting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <KeyRound className="w-4 h-4" />
                )}
                Set Password
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowSetPassword(false);
                  setNewPassword("");
                  setConfirmPassword("");
                  setErrors({});
                }}
                className="px-4 py-2 rounded-md text-sm font-medium border border-gray-300 text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
