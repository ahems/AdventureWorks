import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { toast } from '@/hooks/use-toast';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  signup: (email: string, password: string, firstName: string, lastName: string) => Promise<boolean>;
  logout: () => void;
  updateProfile: (firstName: string, lastName: string, email: string) => Promise<boolean>;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Mock user database stored in localStorage
const USERS_KEY = 'adventureworks_users';
const CURRENT_USER_KEY = 'adventureworks_current_user';

const getStoredUsers = (): Record<string, User & { password: string }> => {
  try {
    const users = localStorage.getItem(USERS_KEY);
    return users ? JSON.parse(users) : {};
  } catch {
    return {};
  }
};

const saveUsers = (users: Record<string, User & { password: string }>) => {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
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
    
    const users = getStoredUsers();
    const storedUser = users[email.toLowerCase()];
    
    if (!storedUser) {
      setIsLoading(false);
      toast({
        title: "Login Failed",
        description: "No account found with this email. Please sign up first!",
        variant: "destructive",
      });
      return false;
    }
    
    if (storedUser.password !== password) {
      setIsLoading(false);
      toast({
        title: "Login Failed",
        description: "Incorrect password. Please try again.",
        variant: "destructive",
      });
      return false;
    }
    
    const { password: _, ...userWithoutPassword } = storedUser;
    setUser(userWithoutPassword);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(userWithoutPassword));
    setIsLoading(false);
    
    toast({
      title: "Welcome back!",
      description: `Good to see you again, ${storedUser.firstName}!`,
    });
    
    return true;
  }, []);

  const signup = useCallback(async (
    email: string, 
    password: string, 
    firstName: string, 
    lastName: string
  ): Promise<boolean> => {
    setIsLoading(true);
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 800));
    
    const users = getStoredUsers();
    
    if (users[email.toLowerCase()]) {
      setIsLoading(false);
      toast({
        title: "Signup Failed",
        description: "An account with this email already exists. Please login instead.",
        variant: "destructive",
      });
      return false;
    }
    
    const newUser: User & { password: string } = {
      id: `user_${Date.now()}`,
      email: email.toLowerCase(),
      firstName,
      lastName,
      password,
      createdAt: new Date().toISOString(),
    };
    
    users[email.toLowerCase()] = newUser;
    saveUsers(users);
    
    const { password: _, ...userWithoutPassword } = newUser;
    setUser(userWithoutPassword);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(userWithoutPassword));
    setIsLoading(false);
    
    toast({
      title: "Account Created!",
      description: `Welcome to Adventure Works, ${firstName}!`,
    });
    
    return true;
  }, []);

  const logout = useCallback(() => {
    const userName = user?.firstName;
    setUser(null);
    localStorage.removeItem(CURRENT_USER_KEY);
    
    toast({
      title: "Logged Out",
      description: `See you on the trails, ${userName}!`,
    });
  }, [user]);

  const updateProfile = useCallback(async (
    firstName: string,
    lastName: string,
    newEmail: string
  ): Promise<boolean> => {
    if (!user) return false;
    
    setIsLoading(true);
    
    // Simulate network delay
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const users = getStoredUsers();
    const oldEmail = user.email.toLowerCase();
    const normalizedNewEmail = newEmail.toLowerCase();
    
    // Check if new email already exists (and it's not the current user)
    if (normalizedNewEmail !== oldEmail && users[normalizedNewEmail]) {
      setIsLoading(false);
      toast({
        title: "Update Failed",
        description: "An account with this email already exists.",
        variant: "destructive",
      });
      return false;
    }
    
    // Get the current user's password
    const currentUserData = users[oldEmail];
    if (!currentUserData) {
      setIsLoading(false);
      return false;
    }
    
    // Update user data
    const updatedUser: User & { password: string } = {
      ...currentUserData,
      firstName,
      lastName,
      email: normalizedNewEmail,
    };
    
    // If email changed, remove old entry and add new one
    if (normalizedNewEmail !== oldEmail) {
      delete users[oldEmail];
    }
    users[normalizedNewEmail] = updatedUser;
    saveUsers(users);
    
    const { password: _, ...userWithoutPassword } = updatedUser;
    setUser(userWithoutPassword);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(userWithoutPassword));
    setIsLoading(false);
    
    toast({
      title: "Profile Updated",
      description: "Your profile has been updated successfully!",
    });
    
    return true;
  }, [user]);

  return (
    <AuthContext.Provider value={{
      user,
      isLoading,
      login,
      signup,
      logout,
      updateProfile,
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
