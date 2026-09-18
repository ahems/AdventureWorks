import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { toast } from "@/hooks/use-toast";
import { ODATA_BASE, MANUFACTURING_BASE } from "@/config/api";

interface User {
  id: string;
  businessEntityId: number;
  email: string;
  firstName: string;
  lastName: string;
  role: "employee";
  createdAt: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const CURRENT_USER_KEY = "adventureworks_manufacturing_user";

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const storedUser = localStorage.getItem(CURRENT_USER_KEY);
      return storedUser ? (JSON.parse(storedUser) as User) : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(false);

  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setIsLoading(true);

      try {
        // Step 1: Look up email via DAB REST API
        const escapedEmail = email.replace(/'/g, "''");
        const emailFilter = `EmailAddress eq '${escapedEmail}'`;
        const emailRes = await fetch(
          `${ODATA_BASE}/EmailAddress?$filter=${encodeURIComponent(emailFilter)}`,
        );
        if (!emailRes.ok) {
          throw new Error(`API error: ${emailRes.status}`);
        }
        const emailData = await emailRes.json();
        const emailRecord = emailData?.value?.[0];

        if (!emailRecord) {
          toast({
            title: "Login Failed",
            description: "Invalid credentials – account not found.",
            variant: "destructive",
          });
          return false;
        }

        // Step 2: Look up person by BusinessEntityID
        const personFilter = `BusinessEntityID eq ${emailRecord.BusinessEntityID}`;
        const personRes = await fetch(
          `${ODATA_BASE}/Person?$filter=${encodeURIComponent(personFilter)}`,
        );
        if (!personRes.ok) {
          throw new Error(`API error: ${personRes.status}`);
        }
        const personData = await personRes.json();
        const person = personData?.value?.[0];

        if (!person || person.PersonType !== "EM") {
          toast({
            title: "Access Denied",
            description: "This portal is restricted to employees.",
            variant: "destructive",
          });
          return false;
        }

        // Step 3: Verify password via Functions API
        const verifyRes = await fetch(`${MANUFACTURING_BASE}/password/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessEntityID: emailRecord.BusinessEntityID,
            password,
          }),
        });

        if (!verifyRes.ok) {
          toast({
            title: "Login Failed",
            description: "Incorrect password.",
            variant: "destructive",
          });
          return false;
        }

        const verifyData = await verifyRes.json();
        if (!verifyData?.isValid) {
          toast({
            title: "Login Failed",
            description: "Incorrect password.",
            variant: "destructive",
          });
          return false;
        }

        const loggedInUser: User = {
          id: `emp_${emailRecord.BusinessEntityID}`,
          businessEntityId: emailRecord.BusinessEntityID,
          email: emailRecord.EmailAddress,
          firstName: person.FirstName,
          lastName: person.LastName,
          role: "employee",
          createdAt: new Date().toISOString(),
        };

        setUser(loggedInUser);
        localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(loggedInUser));

        toast({
          title: "Welcome back!",
          description: `Logged in as ${person.FirstName} ${person.LastName}`,
        });
        return true;
      } catch (err) {
        console.error("Login error:", err);
        toast({
          title: "Login Error",
          description:
            "Unable to connect to authentication service. Please try again.",
          variant: "destructive",
        });
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const logout = useCallback(() => {
    const userName = user?.firstName;
    setUser(null);
    localStorage.removeItem(CURRENT_USER_KEY);
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
