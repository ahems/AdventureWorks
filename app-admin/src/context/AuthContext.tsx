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
