import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { handleCallback } from "@/services/dabAuth";

/**
 * Handles the OAuth redirect (`/oauth/callback`) from the api-mcp authorization
 * server for the e-shop's Data API (DAB) token: validates state, exchanges the
 * authorization code (with the PKCE verifier) for a DAB-resource access token,
 * then returns the consumer to the page they started from.
 */
const OAuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React 18 StrictMode double-invoke
    ran.current = true;
    (async () => {
      const result = await handleCallback();
      if (result.ok) {
        navigate(result.returnTo || "/", { replace: true });
      } else {
        setError(result.error ?? "Authorization failed.");
      }
    })();
  }, [navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="max-w-md w-full text-center space-y-4">
        {error ? (
          <>
            <ShieldAlert className="h-10 w-10 text-destructive mx-auto" />
            <h1 className="text-xl font-semibold">Authorization failed</h1>
            <p className="text-sm text-muted-foreground break-words">{error}</p>
            <button
              className="text-sm underline text-primary"
              onClick={() => navigate("/", { replace: true })}
            >
              Back to store
            </button>
          </>
        ) : (
          <>
            <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto" />
            <h1 className="text-xl font-semibold flex items-center justify-center gap-2">
              <ShieldCheck className="h-5 w-5" /> Completing sign-in…
            </h1>
            <p className="text-sm text-muted-foreground">
              Exchanging the authorization code for a Data API access token.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default OAuthCallbackPage;
