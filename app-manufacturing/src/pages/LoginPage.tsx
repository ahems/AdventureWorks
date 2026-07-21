import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2, Eye, EyeOff, HardHat } from "lucide-react";
import ManufacturingLogo from "@/components/ManufacturingLogo";
import { useAuth } from "@/context/AuthContext";
import { z } from "zod";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email" }),
  password: z.string().min(1, { message: "Password is required" }),
});

const LoginPage: React.FC = () => {
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const { login, isLoading } = useAuth();
  const navigate = useNavigate();

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

    const success = await login(email, password);
    if (success) {
      navigate("/", { replace: true });
    }
  };

  return (
    <div className="min-h-screen bg-doodle-bg flex flex-col">
      {/* Header */}
      <header className="border-b-4 border-doodle-text">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between h-16">
            <Link to="/" className="flex items-center gap-2 group">
              <div className="group-hover:rotate-6 transition-transform">
                <ManufacturingLogo className="w-8 h-8" />
              </div>
              <div className="flex flex-col">
                <span className="font-doodle text-xl font-bold text-doodle-text leading-tight">
                  Adventure<span className="text-doodle-accent">Works</span>
                </span>
                <span className="font-doodle text-xs text-doodle-text/60 -mt-1">
                  Manufacturing Hub
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
                <HardHat className="w-8 h-8 text-doodle-green" />
              </div>
              <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text">
                Employee Login
              </h1>
              <p className="font-doodle text-doodle-text/70 mt-2">
                Sign in with your corporate credentials
              </p>
            </div>

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
                <p className="font-doodle text-xs text-doodle-text">
                  <span className="text-doodle-text/60">Email:</span>{" "}
                  <button
                    type="button"
                    className="underline hover:no-underline"
                    onClick={() => setEmail("demo.admin@adventureworks.com")}
                  >
                    demo.admin@adventureworks.com
                  </button>
                </p>
                <p className="font-doodle text-xs text-doodle-text">
                  <span className="text-doodle-text/60">Password:</span>{" "}
                  <button
                    type="button"
                    className="underline hover:no-underline"
                    onClick={() => setPassword("Admin1234!")}
                  >
                    Admin1234!
                  </button>
                </p>
                <p className="font-doodle text-xs text-doodle-text/50 italic pt-1">
                  Seeded into the database at deploy time. Click to fill.
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
