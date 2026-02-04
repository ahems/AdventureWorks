import React, { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Loader2,
  Eye,
  EyeOff,
  Bike,
  CheckCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Twemoji } from "@/components/Twemoji";
import { validateResetToken, resetPassword } from "@/lib/authService";
import { toast } from "@/hooks/use-toast";

const resetSchema = z
  .object({
    password: z
      .string()
      .min(8, { message: "Password must be at least 8 characters" }),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

const ResetPasswordPage: React.FC = () => {
  const { t } = useTranslation("account");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [token, setToken] = useState<string | null>(null);
  const [businessEntityId, setBusinessEntityId] = useState<number | null>(null);
  const [isValidating, setIsValidating] = useState(true);
  const [isValidToken, setIsValidToken] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const tokenParam = searchParams.get("token");
    const idParam = searchParams.get("id");

    if (!tokenParam || !idParam) {
      setIsValidating(false);
      setIsValidToken(false);
      return;
    }

    setToken(tokenParam);
    const parsedId = parseInt(idParam);
    setBusinessEntityId(parsedId);

    // Validate token
    const validate = async () => {
      const result = await validateResetToken(parsedId, tokenParam);
      setIsValidToken(result.isValid);
      setIsValidating(false);
    };

    validate();
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const result = resetSchema.safeParse({ password, confirmPassword });
    if (!result.success) {
      const fieldErrors: Record<string, string> = {};
      result.error.errors.forEach((err) => {
        if (err.path[0]) {
          fieldErrors[err.path[0] as string] = err.message;
        }
      });
      setErrors(fieldErrors);
      return;
    }

    if (!token || !businessEntityId) {
      toast({
        title: "Error",
        description: "Invalid reset link",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    const resetResult = await resetPassword(businessEntityId, token, password);
    setIsLoading(false);

    if (resetResult.success) {
      setIsSuccess(true);
      toast({
        title: "Password Reset Successful",
        description: "Your password has been updated. You can now sign in.",
      });

      // Redirect to auth page after 3 seconds
      setTimeout(() => {
        navigate("/auth");
      }, 3000);
    } else {
      toast({
        title: "Reset Failed",
        description: resetResult.error || "Failed to reset password.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-doodle-bg flex flex-col">
      {/* Header */}
      <header className="border-b-4 border-doodle-text">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-2 group">
              <div className="doodle-border-light p-1.5 group-hover:rotate-6 transition-transform">
                <Bike className="w-6 h-6 text-doodle-text" />
              </div>
              <span className="font-doodle text-xl font-bold text-doodle-text">
                Adventure<span className="text-doodle-accent">Works</span>
              </span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          {/* Back Link */}
          <Link
            to="/auth"
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Sign In
          </Link>

          {/* Reset Card */}
          <div className="doodle-card p-6 md:p-8">
            {isValidating ? (
              <div className="text-center py-12">
                <Loader2 className="w-12 h-12 animate-spin text-doodle-accent mx-auto mb-4" />
                <p className="font-doodle text-doodle-text">
                  Validating reset link...
                </p>
              </div>
            ) : !isValidToken ? (
              <div className="text-center py-8">
                <div className="block mb-4">
                  <Twemoji emoji="⚠️" size="4rem" />
                </div>
                <h1 className="font-doodle text-2xl font-bold text-doodle-accent mb-3">
                  Invalid or Expired Link
                </h1>
                <p className="font-doodle text-doodle-text/70 mb-6">
                  This password reset link is invalid or has expired. Please
                  request a new one.
                </p>
                <Link
                  to="/auth"
                  className="doodle-button doodle-button-primary inline-block"
                >
                  Back to Sign In
                </Link>
              </div>
            ) : isSuccess ? (
              <div className="text-center py-8">
                <CheckCircle className="w-16 h-16 text-doodle-green mx-auto mb-4" />
                <h1 className="font-doodle text-2xl font-bold text-doodle-green mb-3">
                  Password Reset Complete!
                </h1>
                <p className="font-doodle text-doodle-text/70 mb-4">
                  Your password has been successfully updated.
                </p>
                <p className="font-doodle text-sm text-doodle-text/60">
                  Redirecting to sign in page...
                </p>
              </div>
            ) : (
              <>
                <div className="text-center mb-6">
                  <div className="block mb-3">
                    <Twemoji emoji="🔑" size="4rem" />
                  </div>
                  <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text">
                    Reset Your Password
                  </h1>
                  <p className="font-doodle text-doodle-text/70 mt-2">
                    Enter your new password below
                  </p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  {/* New Password */}
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      New Password
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className={`doodle-input w-full pr-10 ${
                          errors.password ? "border-doodle-accent" : ""
                        }`}
                        placeholder="Enter new password (min 8 characters)"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-doodle-text/50 hover:text-doodle-text"
                      >
                        {showPassword ? (
                          <EyeOff className="w-5 h-5" />
                        ) : (
                          <Eye className="w-5 h-5" />
                        )}
                      </button>
                    </div>
                    {errors.password && (
                      <p className="font-doodle text-xs text-doodle-accent mt-1">
                        {errors.password}
                      </p>
                    )}
                  </div>

                  {/* Confirm Password */}
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      Confirm Password
                    </label>
                    <input
                      type={showPassword ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={`doodle-input w-full ${
                        errors.confirmPassword ? "border-doodle-accent" : ""
                      }`}
                      placeholder="Confirm new password"
                    />
                    {errors.confirmPassword && (
                      <p className="font-doodle text-xs text-doodle-accent mt-1">
                        {errors.confirmPassword}
                      </p>
                    )}
                  </div>

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="doodle-button doodle-button-primary w-full py-3 text-lg flex items-center justify-center gap-2"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Resetting Password...
                      </>
                    ) : (
                      "Reset Password"
                    )}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
};

export default ResetPasswordPage;
