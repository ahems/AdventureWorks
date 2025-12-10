import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { toast } from '@/hooks/use-toast';
import { loginUser, signupUser, updateUserProfile } from '@/lib/authService';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  businessEntityId: number;
  emailAddressId?: number;
  createdAt?: string;
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

// Session storage key for current user
const CURRENT_USER_KEY = 'adventureworks_current_user';

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
    
    const result = await loginUser(email, password);
    
    if (!result.success) {
      setIsLoading(false);
      toast({
        title: "Login Failed",
        description: result.error || "An error occurred during login.",
        variant: "destructive",
      });
      return false;
    }
    
    const userData = result.user!;
    const user: User = {
      id: String(userData.businessEntityId),
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      businessEntityId: userData.businessEntityId,
      emailAddressId: userData.emailAddressId
    };
    
    setUser(user);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
    setIsLoading(false);
    
    toast({
      title: "Welcome back!",
      description: `Good to see you again, ${userData.firstName}!`,
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
    
    const result = await signupUser(email, password, firstName, lastName);
    
    if (!result.success) {
      setIsLoading(false);
      toast({
        title: "Signup Failed",
        description: result.error || "An error occurred during signup.",
        variant: "destructive",
      });
      return false;
    }
    
    const userData = result.user!;
    const user: User = {
      id: String(userData.businessEntityId),
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      businessEntityId: userData.businessEntityId,
      emailAddressId: userData.emailAddressId
    };
    
    setUser(user);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(user));
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
    
    const result = await updateUserProfile(
      user.businessEntityId,
      user.emailAddressId || 0,
      firstName,
      lastName,
      newEmail,
      user.email
    );
    
    if (!result.success) {
      setIsLoading(false);
      toast({
        title: "Update Failed",
        description: result.error || "An error occurred while updating your profile.",
        variant: "destructive",
      });
      return false;
    }
    
    const updatedUser: User = {
      ...user,
      firstName,
      lastName,
      email: newEmail,
    };
    
    setUser(updatedUser);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(updatedUser));
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
