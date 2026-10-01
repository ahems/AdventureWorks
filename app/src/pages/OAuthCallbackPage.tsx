import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { handleCallback as handleDabCallback } from "@/services/dabAuth";
import {
  handleCallback as handleFunctionsCallback,
  hasPendingAuthorization as hasPendingFunctionsAuthorization,
} from "@/services/functionsAuth";

/**
 * Handles the OAuth redirect (`/oauth/callback`) from the api-mcp authorization
 * server. The e-shop acquires two distinct single-resource tokens from the same
 * server — one for the Data API (DAB) and one for the Functions API — which share
 * this callback route. The pending PKCE marker disambiguates which flow to
 * complete; the code is exchanged (with its PKCE verifier) for the resource
 * access token, then the consumer is returned to the page they started from.
 */
const OAuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React 18 StrictMode double-invoke
    ran.current = true;
    (async () => {
      const result = hasPendingFunctionsAuthorization()
        ? await handleFunctionsCallback()
        : await handleDabCallback();
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
