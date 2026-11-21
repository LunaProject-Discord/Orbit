import { OAuthCallback } from "@/components/oauth-callback";

/** Microsoft のログイン画面からの戻り先。 */
export default function MicrosoftCallbackPage() {
  return <OAuthCallback provider="microsoft" />;
}
