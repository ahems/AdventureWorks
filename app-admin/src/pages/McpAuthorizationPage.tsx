import React, { useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  ShieldCheck,
  ShieldAlert,
  KeyRound,
  LogIn,
  LogOut,
  Eye,
  EyeOff,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import AdminHeader from "@/components/AdminHeader";
import Footer from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/context/AuthContext";
import {
  beginAuthorization,
  clearAuthorization,
  getAccessToken,
  getCurrentClaims,
  getGrantedScopes,
  isAuthorized,
} from "@/services/mcpAuth";
import { evaluateTools } from "@/services/mcpToolMatrix";

/**
 * Admin "MCP Authorization" inspection page. Demonstrates the full delegated
 * OAuth story for the currently signed-in employee: initiate Authorization Code
 * + PKCE (S256), then show the resulting resource-bound token's claims and a
 * live allow/deny preview for every MCP tool based on the granted scopes.
 *
 * All enforcement is server-side (McpToolAuthorizationFilter). This page mirrors
 * the same policy for transparency and never displays the raw token by default.
 */
const McpAuthorizationPage: React.FC = () => {
  const { user } = useAuth();
  const [authorized, setAuthorized] = useState(isAuthorized());
  const [busy, setBusy] = useState(false);
  const [revealToken, setRevealToken] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const claims = authorized ? getCurrentClaims() : null;
  const grantedScopes = authorized ? getGrantedScopes() : [];
  const category = (claims?.category as string) ?? "employee";

  const decisions = useMemo(
    () => (authorized ? evaluateTools(grantedScopes, category) : []),
    [authorized, grantedScopes, category],
  );
  const allowedCount = decisions.filter((d) => d.allowed).length;

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const handleConnect = async () => {
    setError(null);
    setBusy(true);
    try {
      await beginAuthorization(user.email);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const handleDisconnect = () => {
    clearAuthorization();
    setAuthorized(false);
    setRevealToken(false);
  };

  const expiresAt = claims?.exp ? new Date(claims.exp * 1000) : null;
  const issuedAt = claims?.iat ? new Date(claims.iat * 1000) : null;
  const rawToken = revealToken ? getAccessToken() : null;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <AdminHeader />
      <main className="flex-1 container mx-auto px-4 py-8 space-y-6 max-w-6xl">
        <div className="flex items-center gap-3">
          <KeyRound className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">MCP Authorization</h1>
            <p className="text-sm text-muted-foreground">
              OAuth 2.0 Authorization Code + PKCE (S256) against the AdventureWorks
              MCP resource server. Tool access is derived from your seeded employee
              role — no personas, no second user store.
            </p>
          </div>
        </div>

        {/* Current user + connection controls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Current employee</CardTitle>
            <CardDescription>
              The active AdventureWorks user this authorization is bound to.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <Field label="Name" value={`${user.firstName} ${user.lastName}`} />
              <Field label="Email" value={user.email} />
              <Field label="Business Entity ID" value={String(user.businessEntityId)} />
              <Field label="Application" value="AdventureWorks Admin" />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {authorized ? (
                <Button variant="outline" onClick={handleDisconnect}>
                  <LogOut className="h-4 w-4 mr-2" /> Disconnect (clear token)
                </Button>
              ) : (
                <Button onClick={handleConnect} disabled={busy}>
                  <LogIn className="h-4 w-4 mr-2" />
                  {busy ? "Redirecting…" : "Authorize with MCP (OAuth + PKCE)"}
                </Button>
              )}
              {authorized ? (
                <Badge className="bg-emerald-600 hover:bg-emerald-600">
                  <ShieldCheck className="h-3.5 w-3.5 mr-1" /> Resource-bound token active
                </Badge>
              ) : (
                <Badge variant="secondary">
                  <ShieldAlert className="h-3.5 w-3.5 mr-1" /> Not authorized
                </Badge>
              )}
            </div>
            {error && (
              <p className="text-sm text-destructive break-words">{error}</p>
            )}
          </CardContent>
        </Card>

        {authorized && claims && (
          <>
            {/* Token claims */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Access token claims</CardTitle>
                <CardDescription>
                  Issued by the api-mcp authorization server and validated on every
                  MCP call (signature, issuer, audience, lifetime, subject, scope).
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <Field label="Subject (sub)" value={String(claims.sub ?? "—")} mono />
                  <Field label="User category" value={category} />
                  <Field label="Role" value={String(claims.role ?? "—")} />
                  <Field label="Application (app)" value={String(claims.app ?? "—")} />
                  <Field label="Issuer (iss)" value={String(claims.iss ?? "—")} mono />
                  <Field
                    label="Audience (aud)"
                    value={
                      Array.isArray(claims.aud)
                        ? claims.aud.join(", ")
                        : String(claims.aud ?? "—")
                    }
                    mono
                  />
                  <Field
                    label="Issued at"
                    value={issuedAt ? issuedAt.toLocaleTimeString() : "—"}
                  />
                  <Field
                    label="Expires at"
                    value={expiresAt ? expiresAt.toLocaleTimeString() : "—"}
                  />
                  <Field
                    label="Display name"
                    value={String(claims.name ?? "—")}
                  />
                </div>

                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    Granted scopes ({grantedScopes.length})
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {grantedScopes.length === 0 ? (
                      <span className="text-sm text-muted-foreground">None</span>
                    ) : (
                      grantedScopes.map((s) => (
                        <Badge key={s} variant="outline" className="font-mono text-xs">
                          {s}
                        </Badge>
                      ))
                    )}
                  </div>
                </div>

                <div className="pt-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRevealToken((v) => !v)}
                  >
                    {revealToken ? (
                      <EyeOff className="h-4 w-4 mr-2" />
                    ) : (
                      <Eye className="h-4 w-4 mr-2" />
                    )}
                    {revealToken ? "Hide raw token" : "Reveal raw token"}
                  </Button>
                  {revealToken && rawToken && (
                    <pre className="mt-2 p-2 rounded bg-muted text-xs overflow-x-auto break-all whitespace-pre-wrap">
                      {rawToken}
                    </pre>
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Tool decisions */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  MCP tool authorization
                  <Badge variant="secondary">
                    {allowedCount} allowed / {decisions.length - allowedCount} denied
                  </Badge>
                </CardTitle>
                <CardDescription>
                  Predicted allow/deny for every registered MCP tool, mirroring the
                  server-side policy. Consumer-owned tools additionally enforce
                  ownership from the token subject at call time.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Tool</TableHead>
                        <TableHead>Required scope</TableHead>
                        <TableHead>Access mode</TableHead>
                        <TableHead>Decision</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {decisions.map((d) => (
                        <TableRow key={d.tool}>
                          <TableCell className="font-mono text-xs">{d.tool}</TableCell>
                          <TableCell className="font-mono text-xs">{d.scope}</TableCell>
                          <TableCell className="text-xs">{d.mode}</TableCell>
                          <TableCell>
                            {d.allowed ? (
                              <span className="inline-flex items-center text-emerald-600 text-xs font-medium">
                                <CheckCircle2 className="h-4 w-4 mr-1" /> Allowed
                              </span>
                            ) : (
                              <span className="inline-flex items-center text-destructive text-xs font-medium">
                                <XCircle className="h-4 w-4 mr-1" /> Denied
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {d.reason}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
};

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div>
    <div className="text-xs font-medium text-muted-foreground">{label}</div>
    <div className={`text-sm break-words ${mono ? "font-mono" : ""}`}>{value}</div>
  </div>
);

export default McpAuthorizationPage;
