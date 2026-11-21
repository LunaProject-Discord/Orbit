import { OAuthCallback } from "@/components/oauth-callback";

/** Google のログイン画面からの戻り先。 */
export default function GoogleCallbackPage() {
  return <OAuthCallback provider="google" />;
}
