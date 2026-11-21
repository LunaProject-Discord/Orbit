"use client";

import { useAuth } from "@/components/auth-provider";
import { MailApp } from "@/components/mail/mail-app";

export default function Home() {
  const auth = useAuth();
  // 未ログインの間は AuthGate がログイン画面へ移すので、ここには来ない。
  if (auth.status !== "signed-in") return null;
  return <MailApp user={auth.user} />;
}
