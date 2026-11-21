"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  signIn as apiSignIn,
  signOut as apiSignOut,
  fetchMe,
  getToken,
  onUnauthorized,
  type User,
} from "@/lib/api";
import { releasePush } from "@/lib/notifications";

type AuthState =
  | { status: "loading"; user: null }
  | { status: "signed-out"; user: null }
  | { status: "signed-in"; user: User }
  /** サーバーに届かず、ログイン状態を確かめられなかった。 */
  | { status: "unreachable"; user: null };

type AuthContextValue = AuthState & {
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  retry: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth は AuthProvider の内側で使ってください。");
  }
  return value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: "loading",
    user: null,
  });

  const check = useCallback(async (signal?: AbortSignal) => {
    if (!getToken()) {
      setState({ status: "signed-out", user: null });
      return;
    }
    try {
      const user = await fetchMe(signal);
      setState({ status: "signed-in", user });
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: "signed-out", user: null });
      } else {
        setState({ status: "unreachable", user: null });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const unsubscribe = onUnauthorized(() => {
      // セッションが切れた端末に、新着メールの通知が届き続けないようにする。
      void releasePush(false);
      setState({ status: "signed-out", user: null });
    });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [check]);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      signIn: async (email, password) => {
        await apiSignIn(email, password);
        const user = await fetchMe();
        setState({ status: "signed-in", user });
      },
      signOut: async () => {
        // ログアウトした端末に新着メールの通知が届かないよう、先に送り先を消す。
        await releasePush(true);
        await apiSignOut();
        setState({ status: "signed-out", user: null });
      },
      retry: () => {
        setState({ status: "loading", user: null });
        void check();
      },
    }),
    [state, check],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * ログイン状態に応じて画面を出し分ける。
 * 未ログインなら /login へ、ログイン済みで /login に来たら / へ移す。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const onLoginPage = pathname === "/login" || pathname === "/login/";

  const redirectTo =
    auth.status === "signed-out" && !onLoginPage
      ? "/login"
      : auth.status === "signed-in" && onLoginPage
        ? "/"
        : null;

  useEffect(() => {
    if (redirectTo) router.replace(redirectTo);
  }, [redirectTo, router]);

  if (auth.status === "unreachable") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-semibold text-xl">サーバーに接続できません</h1>
        <p className="text-muted-foreground text-sm">
          ネットワークの状態を確認して、もう一度お試しください。
        </p>
        <Button variant="outline" onClick={auth.retry}>
          再試行
        </Button>
      </main>
    );
  }

  if (auth.status === "loading" || redirectTo) {
    return (
      <main
        className="flex flex-1 items-center justify-center p-8"
        aria-busy="true"
      >
        <output className="text-muted-foreground text-sm">読み込み中…</output>
      </main>
    );
  }

  return <>{children}</>;
}
