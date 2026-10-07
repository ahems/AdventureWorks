import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  ReactNode,
  useEffect,
} from "react";
import { gql } from "graphql-request";
import { toast } from "@/hooks/use-toast";
import { graphqlClient } from "@/lib/graphql-client";
import { getFunctionsApiUrl } from "@/lib/utils";
import {
  clearAuthorization as clearDabAuthorization,
  DAB_SESSION_LOST_EVENT,
  hasPendingAuthorization as hasPendingDabAuthorization,
  hasSession as hasDabSession,
  startSilentSignIn,
} from "@/services/dabAuth";

interface User {
  id: string;
  businessEntityId: number;
  email: string;
  firstName: string;
  lastName: string;
  role: "admin";
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

const CURRENT_USER_KEY = "adventureworks_admin_user";

// Step 1: find the email address record
const FIND_EMAIL_ADDRESS = gql`
  query FindEmailAddress($email: String!) {
    emailAddresses(filter: { EmailAddress: { eq: $email } }) {
      items {
        BusinessEntityID
        EmailAddress
      }
    }
  }
`;

// Step 2: fetch the person by BusinessEntityID (EmailAddress entity has no
// reverse 'people' relationship in the DAB config, so two queries are needed)
const FIND_PERSON_BY_ID = gql`
  query FindPersonById($id: Int!) {
    people(filter: { BusinessEntityID: { eq: $id } }) {
      items {
        BusinessEntityID
        FirstName
        LastName
        PersonType
      }
    }
  }
`;

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const storedUser = localStorage.getItem(CURRENT_USER_KEY);
      if (!storedUser) return null;
      // A signed-in user without a renewable DAB session would see empty pages
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

  const login = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setIsLoading(true);
      // Clear any prior OAuth authorization so a user switch never inherits the
      // previous employee's delegated DAB token, scopes or role.
      clearDabAuthorization();

      try {
        // Step 1: Look up email in DAB
        const emailData = await graphqlClient.request<{
          emailAddresses: {
            items: Array<{
              BusinessEntityID: number;
              EmailAddress: string;
            }>;
          };
        }>(FIND_EMAIL_ADDRESS, { email });

        const emailRecord = emailData?.emailAddresses?.items?.[0];
        if (!emailRecord) {
          toast({
            title: "Login Failed",
            description: "Invalid credentials – account not found.",
            variant: "destructive",
          });
          return false;
        }

        // Step 2: Look up person by BusinessEntityID
        const personData = await graphqlClient.request<{
          people: {
            items: Array<{
              BusinessEntityID: number;
              FirstName: string;
              LastName: string;
              PersonType: string;
            }>;
          };
        }>(FIND_PERSON_BY_ID, { id: emailRecord.BusinessEntityID });

        const person = personData?.people?.items?.[0];
        if (!person || person.PersonType !== "EM") {
          toast({
            title: "Access Denied",
            description: "This portal is restricted to employees.",
            variant: "destructive",
          });
          return false;
        }

        // Step 3: Verify password via Functions
        const functionsUrl = getFunctionsApiUrl();
        const verifyRes = await fetch(`${functionsUrl}/api/password/verify`, {
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
          role: "admin",
          createdAt: new Date().toISOString(),
        };

        localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(loggedInUser));

        // Silently obtain the delegated DAB token: signs the employee in to the
        // api-mcp authorization server with the same credentials and completes the
        // Authorization Code + PKCE flow (no consent page for this first-party app).
        // The browser briefly leaves the app and returns via /oauth/callback.
        try {
          await startSilentSignIn(emailRecord.EmailAddress, password, "/");
          return true;
        } catch (err) {
          console.error("Silent DAB sign-in failed:", err);
          localStorage.removeItem(CURRENT_USER_KEY);
          toast({
            title: "Login Error",
            description:
              "Signed in, but could not obtain data access. Please try again.",
            variant: "destructive",
          });
          return false;
        }
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
    // the previous employee's delegated token/scopes.
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
