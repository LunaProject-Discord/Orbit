"use client";

import { AdminSetup } from "@/components/admin/admin-setup";

/** 初回セットアップ (管理者が 1 人もいないときに、最初の管理者を作る)。 */
export default function AdminSetupPage() {
  return <AdminSetup />;
}
