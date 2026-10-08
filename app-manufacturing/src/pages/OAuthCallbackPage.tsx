import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { handleCallback as handleDabCallback } from "@/services/dabAuth";
import { useAuth } from "@/context/AuthContext";

/**
 * Handles the OAuth redirect (`/oauth/callback`) from the api-mcp authorization
 * server for the DAB-resource token. The flow runs silently right after the
 * employee signs in and returns them to the dashboard.
 */
const OAuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React 18 StrictMode double-invoke
    ran.current = true;
    (async () => {
      const result = await handleDabCallback();
      if (result.ok) {
        navigate(result.returnTo || "/", { replace: true });
      } else {
        setError(result.error ?? "Authorization failed.");
      }
    })();
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-doodle-bg p-6">
      <div className="max-w-md w-full text-center space-y-4 font-doodle text-doodle-text">
        {error ? (
          <>
            <ShieldAlert className="h-10 w-10 text-red-600 mx-auto" />
            <h1 className="text-xl font-bold">Authorization failed</h1>
            <p className="text-sm text-doodle-text/70 break-words">{error}</p>
            <button
              className="text-sm underline text-doodle-accent"
              onClick={() => {
                logout();
                navigate("/login", { replace: true });
              }}
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <Loader2 className="h-10 w-10 animate-spin text-doodle-accent mx-auto" />
            <h1 className="text-xl font-bold flex items-center justify-center gap-2">
              <ShieldCheck className="h-5 w-5" /> Completing sign-in…
            </h1>
            <p className="text-sm text-doodle-text/70">
              Exchanging the authorization code for a resource-bound access token.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default OAuthCallbackPage;
