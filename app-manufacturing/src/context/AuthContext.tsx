import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import { toast } from "@/hooks/use-toast";
import {
  DAB_SESSION_LOST_EVENT,
  clearAuthorization as clearDabAuthorization,
  getCurrentClaims,
  getDabRole,
  hasPendingAuthorization as hasPendingDabAuthorization,
  hasSession as hasDabSession,
  startSilentSignIn,
} from "@/services/dabAuth";

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: "employee";
  /** Application role granted by the authorization server, e.g. "manufacturing-engineer". */
  appRole?: string;
  createdAt: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  /** Builds the signed-in user from the freshly issued token (called by /oauth/callback). */
  completeSignIn: () => boolean;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const CURRENT_USER_KEY = "adventureworks_manufacturing_user";
// Email typed on the login form; the access token deliberately carries no email claim.
const PENDING_EMAIL_KEY = "adventureworks_manufacturing_pending_email";

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const storedUser = localStorage.getItem(CURRENT_USER_KEY);
      if (!storedUser) return null;
      // A signed-in user without a renewable DAB session would see 403s
      // (DAB rejects anonymous reads), so treat it as signed out.
      if (!hasDabSession() && !hasPendingDabAuthorization()) {
        localStorage.removeItem(CURRENT_USER_KEY);
        return null;
      }
      return JSON.parse(storedUser) as User;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(false);

  // Credentials are checked only by the api-mcp authorization server, which also
  // decides whether this account may use the manufacturing portal (manufacturing
  // staff only). Nothing is looked up anonymously in the browser.
  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setIsLoading(true);
      // Clear any prior OAuth authorization so a user switch never inherits the
      // previous employee's delegated tokens or role.
      clearDabAuthorization();
      localStorage.removeItem(CURRENT_USER_KEY);
      sessionStorage.setItem(PENDING_EMAIL_KEY, email.trim());

      try {
        // Leaves the app: api-mcp /login → /authorize → back to /oauth/callback.
        await startSilentSignIn(email.trim(), password, "/");
        return true;
      } catch (err) {
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
    [],
  );

  const completeSignIn = useCallback((): boolean => {
    const claims = getCurrentClaims();
    if (!claims?.sub) return false;
    const fullName = typeof claims.name === "string" ? claims.name.trim() : "";
    const [firstName, ...rest] = fullName ? fullName.split(/\s+/) : ["Employee"];
    const signedIn: User = {
      id: `emp_${claims.sub}`,
      email: sessionStorage.getItem(PENDING_EMAIL_KEY) ?? "",
      firstName,
      lastName: rest.join(" "),
      role: "employee",
      appRole: getDabRole() ?? undefined,
      createdAt: new Date().toISOString(),
    };
    sessionStorage.removeItem(PENDING_EMAIL_KEY);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(signedIn));
    setUser(signedIn);
    return true;
  }, []);

  // Refresh token rejected/expired: the data session is over, so end the app session.
  useEffect(() => {
    const onSessionLost = () => {
      if (!localStorage.getItem(CURRENT_USER_KEY)) return;
      setUser(null);
      localStorage.removeItem(CURRENT_USER_KEY);
      toast({
        title: "Session expired",
        description: "Please sign in again.",
        variant: "destructive",
      });
    };
    window.addEventListener(DAB_SESSION_LOST_EVENT, onSessionLost);
    return () => window.removeEventListener(DAB_SESSION_LOST_EVENT, onSessionLost);
  }, []);

  const logout = useCallback(() => {
    const userName = user?.firstName;
    setUser(null);
    localStorage.removeItem(CURRENT_USER_KEY);
    // Clear the OAuth authorization context so the next user cannot inherit
    // the previous employee's delegated token/role.
    clearDabAuthorization();
    toast({
      title: "Logged Out",
      description: `Goodbye, ${userName}! See you next time.`,
    });
  }, [user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        login,
        completeSignIn,
        logout,
        isAuthenticated: !!user,
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
