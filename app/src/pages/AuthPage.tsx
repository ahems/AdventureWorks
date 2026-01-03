import React, { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Loader2, Eye, EyeOff, Bike } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/AuthContext";
import { z } from "zod";
import { Twemoji } from "@/components/Twemoji";
import { TwemojiText } from "@/components/TwemojiText";

const loginSchema = z.object({
  email: z.string().email({ message: "Please enter a valid email" }),
  password: z
    .string()
    .min(6, { message: "Password must be at least 6 characters" }),
});

const signupSchema = z
  .object({
    firstName: z.string().min(1, { message: "First name is required" }).max(50),
    lastName: z.string().min(1, { message: "Last name is required" }).max(50),
    email: z.string().email({ message: "Please enter a valid email" }),
    password: z
      .string()
      .min(6, { message: "Password must be at least 6 characters" }),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

const AuthPage: React.FC = () => {
  const { t } = useTranslation("account");
  const [isLogin, setIsLogin] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  const { login, signup, isLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const from =
    (location.state as { from?: { pathname: string } })?.from?.pathname || "/";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});

    if (isLogin) {
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
        navigate(from, { replace: true });
      }
    } else {
      const result = signupSchema.safeParse({
        firstName,
        lastName,
        email,
        password,
        confirmPassword,
      });
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

      const success = await signup(email, password, firstName, lastName);
      if (success) {
        navigate(from, { replace: true });
      }
    }
  };

  const toggleMode = () => {
    setIsLogin(!isLogin);
    setErrors({});
    setPassword("");
    setConfirmPassword("");
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
            to="/"
            className="inline-flex items-center gap-2 font-doodle text-doodle-text/70 hover:text-doodle-accent transition-colors mb-6"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("auth.backToShop")}
          </Link>

          {/* Auth Card */}
          <div className="doodle-card p-6 md:p-8">
            <div className="text-center mb-6">
              <div className="block mb-3">
                <Twemoji emoji={isLogin ? "👋" : "🎉"} size="5rem" />
              </div>
              <h1 className="font-doodle text-2xl md:text-3xl font-bold text-doodle-text">
                {isLogin ? t("auth.welcomeBack") : t("auth.joinAdventure")}
              </h1>
              <p className="font-doodle text-doodle-text/70 mt-2">
                {isLogin
                  ? t("auth.signInToAccount")
                  : t("auth.createFreeAccount")}
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Signup Fields */}
              {!isLogin && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      {t("auth.firstName")}
                    </label>
                    <input
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className={`doodle-input w-full ${
                        errors.firstName ? "border-doodle-accent" : ""
                      }`}
                      placeholder={t("auth.firstNamePlaceholder")}
                    />
                    {errors.firstName && (
                      <p className="font-doodle text-xs text-doodle-accent mt-1">
                        {errors.firstName}
                      </p>
                    )}
                  </div>
                  <div>
                    <label className="font-doodle text-sm text-doodle-text block mb-1">
                      {t("auth.lastName")}
                    </label>
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className={`doodle-input w-full ${
                        errors.lastName ? "border-doodle-accent" : ""
                      }`}
                      placeholder={t("auth.lastNamePlaceholder")}
                    />
                    {errors.lastName && (
                      <p className="font-doodle text-xs text-doodle-accent mt-1">
                        {errors.lastName}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Email */}
              <div>
                <label className="font-doodle text-sm text-doodle-text block mb-1">
                  {t("auth.emailAddress")}
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={`doodle-input w-full ${
                    errors.email ? "border-doodle-accent" : ""
                  }`}
                  placeholder={t("auth.emailPlaceholder")}
                />
                {errors.email && (
                  <p className="font-doodle text-xs text-doodle-accent mt-1">
                    {errors.email}
                  </p>
                )}
              </div>

              {/* Password */}
              <div>
                <label className="font-doodle text-sm text-doodle-text block mb-1">
                  {t("auth.password")}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`doodle-input w-full pr-10 ${
                      errors.password ? "border-doodle-accent" : ""
                    }`}
                    placeholder={t("auth.passwordPlaceholder")}
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

              {/* Confirm Password (Signup only) */}
              {!isLogin && (
                <div>
                  <label className="font-doodle text-sm text-doodle-text block mb-1">
                    {t("auth.confirmPassword")}
                  </label>
                  <input
                    type={showPassword ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className={`doodle-input w-full ${
                      errors.confirmPassword ? "border-doodle-accent" : ""
                    }`}
                    placeholder={t("auth.passwordPlaceholder")}
                  />
                  {errors.confirmPassword && (
                    <p className="font-doodle text-xs text-doodle-accent mt-1">
                      {errors.confirmPassword}
                    </p>
                  )}
                </div>
              )}

              {/* Submit Button */}
              <button
                type="submit"
                disabled={isLoading}
                className="doodle-button doodle-button-primary w-full py-3 text-lg flex items-center justify-center gap-2"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    {isLogin ? t("auth.signingIn") : t("auth.creatingAccount")}
                  </>
                ) : isLogin ? (
                  t("auth.signIn")
                ) : (
                  t("auth.signUp")
                )}
              </button>
            </form>

            {/* Toggle Mode */}
            <div className="mt-6 text-center">
              <p className="font-doodle text-doodle-text/70">
                {isLogin
                  ? t("auth.dontHaveAccount")
                  : t("auth.alreadyHaveAccount")}
              </p>
              <button
                onClick={toggleMode}
                className="font-doodle text-doodle-accent hover:text-doodle-green transition-colors font-bold mt-1"
              >
                {isLogin ? t("auth.createOneHere") : t("auth.signInInstead")}
              </button>
            </div>

            {/* Demo Hint */}
            <div className="mt-6 pt-4 border-t-2 border-dashed border-doodle-text/20">
              <p className="font-doodle text-xs text-center text-doodle-text/50">
                <TwemojiText text={t("auth.demoHint")} size="0.875rem" />
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AuthPage;
