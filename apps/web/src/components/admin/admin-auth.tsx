"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type Admin,
  type AdminSignInResult,
  adminPasskeyApi,
  adminSignIn,
  adminSignOut,
  adminVerifyTwoFactor,
  fetchAdminMe,
  getAdminToken,
  onAdminUnauthorized,
} from "@/lib/admin-api";
import { ApiError } from "@/lib/api";
import { signInWithPasskey } from "@/lib/passkey";

type AdminState =
  | { status: "loading"; admin: null }
  | { status: "signed-out"; admin: null }
  | { status: "signed-in"; admin: Admin }
  /** サーバーに届かず、ログイン状態を確かめられなかった。 */
  | { status: "unreachable"; admin: null };

type AdminAuthValue = AdminState & {
  signIn: (username: string, password: string) => Promise<AdminSignInResult>;
  verifyTwoFactor: (
    kind: "totp" | "backup",
    code: string,
    trustDevice: boolean,
  ) => Promise<void>;
  signInWithPasskey: () => Promise<void>;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  retry: () => void;
};

const AdminAuthContext = createContext<AdminAuthValue | null>(null);

export function useAdminAuth(): AdminAuthValue {
  const value = useContext(AdminAuthContext);
  if (!value) {
    throw new Error(
      "useAdminAuth は AdminAuthProvider の内側で使ってください。",
    );
  }
  return value;
}

/**
 * 管理者のログイン状態。一般の利用者のログイン (components/auth-provider.tsx) とは別で、
 * 同じブラウザーで両方にログインしていても互いに影響しない。
 */
export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdminState>({
    status: "loading",
    admin: null,
  });

  const check = useCallback(async (signal?: AbortSignal) => {
    if (!getAdminToken()) {
      setState({ status: "signed-out", admin: null });
      return;
    }
    try {
      const admin = await fetchAdminMe(signal);
      setState({ status: "signed-in", admin });
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: "signed-out", admin: null });
        return;
      }
      setState({ status: "unreachable", admin: null });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const unsubscribe = onAdminUnauthorized(() =>
      setState({ status: "signed-out", admin: null }),
    );
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [check]);

  const enter = useCallback(async () => {
    const admin = await fetchAdminMe();
    setState({ status: "signed-in", admin });
  }, []);

  const value = useMemo<AdminAuthValue>(
    () => ({
      ...state,
      signIn: async (username, password) => {
        const result = await adminSignIn(username, password);
        if (result === "signed-in") await enter();
        return result;
      },
      verifyTwoFactor: async (kind, code, trustDevice) => {
        await adminVerifyTwoFactor(kind, code, trustDevice);
        await enter();
      },
      signInWithPasskey: async () => {
        await signInWithPasskey(adminPasskeyApi);
        await enter();
      },
      refresh: enter,
      signOut: async () => {
        await adminSignOut();
        setState({ status: "signed-out", admin: null });
      },
      retry: () => {
        setState({ status: "loading", admin: null });
        void check();
      },
    }),
    [state, check, enter],
  );

  return (
    <AdminAuthContext.Provider value={value}>
      {children}
    </AdminAuthContext.Provider>
  );
}
