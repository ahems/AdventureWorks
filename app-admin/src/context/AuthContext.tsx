import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { toast } from '@/hooks/use-toast';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: 'admin';
  department: string;
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

const CURRENT_USER_KEY = 'adventureworks_admin_user';

// Mock corporate employees database
const MOCK_EMPLOYEES: Record<string, User & { password: string }> = {
  'admin@adventureworks.com': {
    id: 'emp_001',
    email: 'admin@adventureworks.com',
    firstName: 'Sarah',
    lastName: 'Johnson',
    role: 'admin',
    department: 'Product Management',
    password: 'admin123',
    createdAt: '2023-01-15T00:00:00Z',
  },
  'john.smith@adventureworks.com': {
    id: 'emp_002',
    email: 'john.smith@adventureworks.com',
    firstName: 'John',
    lastName: 'Smith',
    role: 'admin',
    department: 'Customer Service',
    password: 'admin123',
    createdAt: '2023-03-20T00:00:00Z',
  },
  'maria.garcia@adventureworks.com': {
    id: 'emp_003',
    email: 'maria.garcia@adventureworks.com',
    firstName: 'Maria',
    lastName: 'Garcia',
    role: 'admin',
    department: 'Operations',
    password: 'admin123',
    createdAt: '2023-06-10T00:00:00Z',
  },
};

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check for existing session on mount
  useEffect(() => {
    try {
      const storedUser = localStorage.getItem(CURRENT_USER_KEY);
      if (storedUser) {
        setUser(JSON.parse(storedUser));
      }
    } catch {
      // Invalid stored data
    }
    setIsLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    setIsLoading(true);
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const employee = MOCK_EMPLOYEES[email.toLowerCase()];
    
    if (!employee) {
      setIsLoading(false);
      toast({
        title: "Access Denied",
        description: "No employee account found with this email. Please contact IT support.",
        variant: "destructive",
      });
      return false;
    }
    
    if (employee.password !== password) {
      setIsLoading(false);
      toast({
        title: "Login Failed",
        description: "Incorrect password. Please try again or contact IT support.",
        variant: "destructive",
      });
      return false;
    }
    
    const { password: _, ...userWithoutPassword } = employee;
    setUser(userWithoutPassword);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(userWithoutPassword));
    setIsLoading(false);
    
    toast({
      title: "Welcome back!",
      description: `Logged in as ${employee.firstName} ${employee.lastName}`,
    });
    
    return true;
  }, []);

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
    <AuthContext.Provider value={{
      user,
      isLoading,
      login,
      logout,
      isAuthenticated: !!user,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};