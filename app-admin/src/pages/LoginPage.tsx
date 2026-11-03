import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Loader2, Eye, EyeOff, Shield, MousePointerClick, Check } from "lucide-react";
import AdminLogo from "@/components/AdminLogo";
import { useAuth } from "@/context/AuthContext";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email" }),
  password: z.string().min(1, { message: "Password is required" }),
});

const ClickToFillBadge: React.FC<{ filled: boolean }> = ({ filled }) => (
  <span
    className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${
      filled
        ? "border-green-600/40 bg-green-600/10 text-green-700"
        : "border-doodle-accent/50 bg-doodle-accent/10 text-doodle-accent group-hover:bg-doodle-accent group-hover:text-white"
    }`}
  >
    {filled ? (
      <>
        <Check className="w-3 h-3" /> Filled
      </>
    ) : (
      <>
        <MousePointerClick className="w-3 h-3" /> Click to fill
      </>
    )}
  </span>
);

const LoginPage: React.FC = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const { login, isLoading } = useAuth();
  const location = useLocation();
  const authError = (location.state as { authError?: string } | null)?.authError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    const result = loginSchema.safeParse({ email, password });
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

    // On success the browser is redirected through the api-mcp authorization
    // server to obtain the data-access token and returns via /oauth/callback.
    await login(email, password);
  };

  return (
    <div className="min-h-screen bg-doodle-bg flex flex-col">
      {/* Header */}
      <header className="border-b-4 border-doodle-text">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-2 group">
              <div className="group-hover:rotate-6 transition-transform">
                <AdminLogo className="w-8 h-8" />
              </div>
              <div className="flex flex-col">
                <span className="font-doodle text-xl font-bold text-doodle-text leading-tight">
                  Adventure<span className="text-doodle-accent">Works</span>
                </span>
                <span className="font-doodle text-xs text-doodle-text/60 -mt-1">
                  Admin Portal
                </span>
              </div>
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          {/* Auth Card */}
          <div className="doodle-card p-6 md:p-8">
            <div className="text-center mb-6">
              <div className="inline-flex items-center justify-center w-16 h-16 bg-doodle-green/20 border-2 border-doodle-text mb-4">
                <Shield className="w-8 h-8 text-doodle-green" />
              </div>
              <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text">
                Employee Login
              </h1>
              <p className="font-doodle text-doodle-text/70 mt-2">
                Sign in with your corporate credentials
              </p>
            </div>

            {authError && (
              <div
                role="alert"
                className="mb-4 border-2 border-doodle-accent bg-doodle-accent/10 p-3 font-doodle text-sm text-doodle-text"
              >
                {authError}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Email */}
              <div>
                <label
                  htmlFor="email"
                  className="font-doodle text-sm text-doodle-text block mb-1"
                >
                  Email Address
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`doodle-input w-full ${errors.email ? "border-doodle-accent" : ""}`}
                  placeholder="you@adventureworks.com"
                />
                {errors.email && (
                  <p className="font-doodle text-xs text-doodle-accent mt-1">
                    {errors.email}
                  </p>
                )}
              </div>

              {/* Password */}
              <div>
                <label
                  htmlFor="password"
                  className="font-doodle text-sm text-doodle-text block mb-1"
                >
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`doodle-input w-full pr-10 ${errors.password ? "border-doodle-accent" : ""}`}
                    placeholder="••••••••"
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

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading}
                className="doodle-button doodle-button-primary w-full py-3 text-lg flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  "Sign In"
                )}
              </button>
            </form>

            {/* Demo Credentials */}
            <div className="mt-6 pt-4 border-t-2 border-dashed border-doodle-text/20">
              <p className="font-doodle text-sm text-doodle-text/70 mb-3 text-center">
                Demo Credentials
              </p>
              <div className="doodle-border-light p-3 bg-doodle-text/5 space-y-2">
                <button
                  type="button"
                  onClick={() => setEmail("ken0@adventure-works.com")}
                  className="group w-full flex items-center justify-between gap-2 font-doodle text-xs text-doodle-text text-left"
                  title="Click to fill email"
                >
                  <span>
                    <span className="text-doodle-text/60">Email:</span>{" "}
                    <span className="underline group-hover:no-underline">ken0@adventure-works.com</span>
                  </span>
                  <ClickToFillBadge filled={email === "ken0@adventure-works.com"} />
                </button>
                <button
                  type="button"
                  onClick={() => setPassword("Admin1234!")}
                  className="group w-full flex items-center justify-between gap-2 font-doodle text-xs text-doodle-text text-left"
                  title="Click to fill password"
                >
                  <span>
                    <span className="text-doodle-text/60">Password:</span>{" "}
                    <span className="underline group-hover:no-underline">Admin1234!</span>
                  </span>
                  <ClickToFillBadge filled={password === "Admin1234!"} />
                </button>
                <p className="font-doodle text-xs text-doodle-text/50 italic pt-1">
                  Ken Sánchez, Chief Executive Officer (executive-admin).
                </p>
              </div>
            </div>

            {/* Help Text */}
            <p className="font-doodle text-xs text-center text-doodle-text/50 mt-4">
              Forgot your password? Contact IT support.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default LoginPage;
