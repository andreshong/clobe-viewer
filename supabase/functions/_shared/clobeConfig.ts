// clobe OAuth client registered once via `POST /oauth/register` (dynamic client
// registration, public client / PKCE, no client secret). Not sensitive the way a
// confidential-client secret would be, so it is fine to keep as a plain constant
// rather than a Supabase secret.
export const CLOBE_CLIENT_ID = "0e781008-2307-49ce-a609-9abbbdf82bf7";
export const CLOBE_AUTH_BASE = "https://api.clobe.ai";
export const CLOBE_MCP_URL = "https://api.clobe.ai/mcp";
export const CLOBE_COMPANY_ID = "333jqP4oyergXMo0QPYEq";
export const REDIRECT_URI =
  "https://jogjhlqhxrkkjdktvvvs.supabase.co/functions/v1/clobe-oauth-callback";
