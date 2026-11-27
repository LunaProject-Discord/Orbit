"use client";

import { useAuth } from "@/components/auth-provider";
import { CalendarApp } from "@/components/calendar/calendar-app";
import { MailApp } from "@/components/mail/mail-app";
import { usePathnameStore } from "@/lib/app-navigation";
import { isCalendarPath } from "@/lib/calendar/route";

export default function Home() {
  const auth = useAuth();
  const pathname = usePathnameStore();
  // 未ログインの間は AuthGate がログイン画面へ移すので、ここには来ない。
  if (auth.status !== "signed-in") return null;
  if (isCalendarPath(pathname)) return <CalendarApp user={auth.user} />;
  return <MailApp user={auth.user} />;
}
