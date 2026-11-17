import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  ReactNode,
  useEffect,
} from "react";
import { toast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  clearAuthorization as clearDabAuthorization,
  authorizationStorageKey,
  DAB_SESSION_LOST_EVENT,
  getAuthorizationGeneration,
  getTabAuthorizationGeneration,
  getCurrentClaims,
  getDabRole,
  hasSession as hasDabSession,
  isTabAuthorizationGenerationCurrent,
  startSilentSignIn,
} from "@/services/dabAuth";

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "admin";
  /** Application role granted by the authorization server, e.g. "executive-admin". */
  appRole?: string;
  createdAt: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string, returnTo?: string) => Promise<boolean>;
  /** Builds the signed-in user from the freshly issued token (called by /oauth/callback). */
  completeSignIn: (generation: string | null) => boolean;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const CURRENT_USER_KEY = "adventureworks_admin_user";
// Email typed on the login form; the access token deliberately carries no email claim.
const PENDING_EMAIL_KEY = "adventureworks_admin_pending_email";

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const queryClient = useQueryClient();
  const sessionGeneration = useRef(getTabAuthorizationGeneration());
  const [user, setUser] = useState<User | null>(() => {
    try {
      const key = authorizationStorageKey(CURRENT_USER_KEY, sessionGeneration.current);
      const storedUser = localStorage.getItem(key);
      if (!storedUser) return null;
      // A signed-in user without a renewable DAB session would see empty pages
      // (DAB rejects anonymous reads), so treat it as signed out.
      if (!isTabAuthorizationGenerationCurrent(sessionGeneration.current) || !hasDabSession()) {
        localStorage.removeItem(key);
        return null;
      }
      return JSON.parse(storedUser) as User;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(false);

  // Credentials are checked only by the api-mcp authorization server, which also
  // decides whether this account may use the admin portal (employees only). Nothing
  // is looked up anonymously in the browser.
  const login = useCallback(
    async (email: string, password: string, returnTo = "/"): Promise<boolean> => {
      setIsLoading(true);
      queryClient.clear();
      // Clear any prior OAuth authorization so a user switch never inherits the
      // previous employee's delegated tokens, scopes or role.
      const previousGeneration = getAuthorizationGeneration();
      clearDabAuthorization(previousGeneration);
      localStorage.removeItem(authorizationStorageKey(CURRENT_USER_KEY, previousGeneration));
      sessionStorage.setItem(PENDING_EMAIL_KEY, email.trim());

      let attemptGeneration = previousGeneration;
      try {
        // Leaves the app: api-mcp /login → /authorize → back to /oauth/callback.
        const destination =
          returnTo.startsWith("/") &&
          !returnTo.startsWith("//") &&
          !returnTo.includes("\\")
            ? returnTo
            : "/";
        const signIn = startSilentSignIn(email.trim(), password, destination);
        attemptGeneration = getAuthorizationGeneration();
        await signIn;
        return true;
      } catch (err) {
        if (getAuthorizationGeneration() !== attemptGeneration) return false;
        console.error("Sign-in error:", err);
        sessionStorage.removeItem(PENDING_EMAIL_KEY);
        toast({
          title: "Login Error",
          description:
            "Unable to connect to the authentication service. Please try again.",
          variant: "destructive",
        });
        setIsLoading(false);
        return false;
      }
    },
    [queryClient],
  );

  const completeSignIn = useCallback((generation: string | null): boolean => {
    if (!isTabAuthorizationGenerationCurrent(generation)) return false;
    const claims = getCurrentClaims();
    if (!claims?.sub) return false;
    const fullName = typeof claims.name === "string" ? claims.name.trim() : "";
    const [firstName, ...rest] = fullName ? fullName.split(/\s+/) : ["Employee"];
    const signedIn: User = {
      id: `emp_${claims.sub}`,
      email: sessionStorage.getItem(PENDING_EMAIL_KEY) ?? "",
      firstName,
      lastName: rest.join(" "),
      role: "admin",
      appRole: getDabRole() ?? undefined,
      createdAt: new Date().toISOString(),
    };
    sessionStorage.removeItem(PENDING_EMAIL_KEY);
    const key = authorizationStorageKey(CURRENT_USER_KEY, generation);
    localStorage.setItem(key, JSON.stringify(signedIn));
    if (!isTabAuthorizationGenerationCurrent(generation)) {
      localStorage.removeItem(key);
      return false;
    }
    sessionGeneration.current = generation;
    queryClient.clear();
    setUser(signedIn);
    return true;
  }, [queryClient]);

  // Refresh token rejected/expired: the data session is over, so end the app session.
  useEffect(() => {
    const onSessionLost = () => {
      queryClient.clear();
      const key = authorizationStorageKey(CURRENT_USER_KEY, sessionGeneration.current);
      if (!localStorage.getItem(key)) return;
      setUser(null);
      localStorage.removeItem(key);
      toast({
        title: "Session expired",
        description: "Please sign in again.",
        variant: "destructive",
      });
    };
    const checkSession = () => {
      const key = authorizationStorageKey(CURRENT_USER_KEY, sessionGeneration.current);
      if (!isTabAuthorizationGenerationCurrent(sessionGeneration.current) || !localStorage.getItem(key) || !hasDabSession()) {
        onSessionLost();
        setUser(null);
      }
    };
    window.addEventListener(DAB_SESSION_LOST_EVENT, onSessionLost);
    window.addEventListener("storage", checkSession);
    window.addEventListener("focus", checkSession);
    return () => {
      window.removeEventListener(DAB_SESSION_LOST_EVENT, onSessionLost);
      window.removeEventListener("storage", checkSession);
      window.removeEventListener("focus", checkSession);
    };
  }, [queryClient]);

  const logoutGeneration = sessionGeneration.current;
  const logout = useCallback(() => {
    if (sessionGeneration.current !== logoutGeneration) return;
    const userName = user?.firstName;
    queryClient.clear();
    setUser(null);
    localStorage.removeItem(authorizationStorageKey(CURRENT_USER_KEY, logoutGeneration));
    // Clear the OAuth authorization context so the next user cannot inherit
    // the previous employee's delegated token/scopes.
    clearDabAuthorization(logoutGeneration);
    toast({
      title: "Logged Out",
      description: `Goodbye, ${userName}! See you next time.`,
    });
  }, [user, queryClient, logoutGeneration]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login,
        completeSignIn,
        logout,
        isAuthenticated: !!user && isTabAuthorizationGenerationCurrent(sessionGeneration.current),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
