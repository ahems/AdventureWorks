import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { handleCallback as handleMcpCallback } from "@/services/mcpAuth";
import {
  handleCallback as handleDabCallback,
  hasPendingAuthorization as hasPendingDabAuthorization,
} from "@/services/dabAuth";

/**
 * Handles the OAuth redirect (`/oauth/callback`) from the api-mcp authorization
 * server. The route is shared by two PKCE flows — the MCP-resource token
 * (inspection page) and the DAB-resource token (Data API access) — so it
 * dispatches based on which flow has a pending PKCE state in sessionStorage.
 */
const OAuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // guard React 18 StrictMode double-invoke
    ran.current = true;
    (async () => {
      const isDab = hasPendingDabAuthorization();
      const result = isDab
        ? await handleDabCallback()
        : await handleMcpCallback();
      if (result.ok) {
        const target =
          (isDab && result.returnTo) || "/mcp-authorization";
        navigate(target, { replace: true });
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
              onClick={() => navigate("/mcp-authorization", { replace: true })}
            >
              Back to MCP Authorization
            </button>
          </>
        ) : (
          <>
            <Loader2 className="h-10 w-10 animate-spin text-primary mx-auto" />
            <h1 className="text-xl font-semibold flex items-center justify-center gap-2">
              <ShieldCheck className="h-5 w-5" /> Completing sign-in…
            </h1>
            <p className="text-sm text-muted-foreground">
              Exchanging the authorization code for a resource-bound access token.
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default OAuthCallbackPage;
