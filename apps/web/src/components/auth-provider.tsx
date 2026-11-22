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
import { clearOffline, openOffline } from "@/lib/offline";

const USER_KEY = "mail.user";

/** 最後にログインを確かめた利用者。サーバーに届かないときに、この利用者として画面を開く。 */
function rememberedUser(): User | null {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(USER_KEY) ?? "null",
    );
    if (!value || typeof value !== "object") return null;
    const { id, email, name } = value as Record<string, unknown>;
    return typeof id === "string" &&
      typeof email === "string" &&
      typeof name === "string"
      ? { id, email, name }
      : null;
  } catch {
    return null;
  }
}

function rememberUser(user: User): void {
  try {
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // 保存できなくても、サーバーに届く間は使える。
  }
  // 端末内の保存先 (オフライン用) を、この利用者のものにする。
  void openOffline(user.id);
}

/** ログアウトした利用者の、端末内に保存した内容を消す。 */
function forgetUser(): void {
  const user = rememberedUser();
  try {
    window.localStorage.removeItem(USER_KEY);
  } catch {
    // 消せなくても、トークンが無ければ画面は開かない。
  }
  if (user) void clearOffline(user.id);
}

import { safeReturnPath } from "@/lib/route";
import { hasServerUrl, isBundledApp } from "@/lib/server-url";

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
  /** 接続先サーバーを替えたあと、未ログインの状態からやり直す。 */
  reset: () => void;
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
    if (!hasServerUrl() || !getToken()) {
      setState({ status: "signed-out", user: null });
      return;
    }
    try {
      const user = await fetchMe(signal);
      rememberUser(user);
      setState({ status: "signed-in", user });
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ApiError && error.status === 401) {
        setState({ status: "signed-out", user: null });
        return;
      }
      // サーバーに届かなくても、前に確かめた利用者として、端末に保存した内容で開く。
      // (セッションが切れていれば、次に届いたときの 401 でログイン画面へ移る。)
      const user = rememberedUser();
      if (user) {
        rememberUser(user);
        setState({ status: "signed-in", user });
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
      // 端末に保存した内容は消さない (接続後に送るメールを預かっているかもしれない)。
      // 消すのは、自分でログアウトしたときだけにする。
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
        rememberUser(user);
        setState({ status: "signed-in", user });
      },
      signOut: async () => {
        // ログアウトした端末に新着メールの通知が届かないよう、先に送り先を消す。
        await releasePush(true);
        await apiSignOut();
        forgetUser();
        setState({ status: "signed-out", user: null });
      },
      retry: () => {
        setState({ status: "loading", user: null });
        void check();
      },
      reset: () => setState({ status: "signed-out", user: null }),
    }),
    [state, check],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * ログイン状態に応じて画面を出し分ける。
 * 未ログインなら /login へ、ログイン済みで /login に来たら / へ移す。
 * 開こうとしていた URL は /login?next= に控えておき、ログインしたらそこへ戻す。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const onLoginPage = pathname === "/login" || pathname === "/login/";
  /** 接続先サーバーの設定画面 (同梱アプリ用)。ログインの前後どちらでも開ける。 */
  const onServerPage = pathname === "/server" || pathname === "/server/";

  const redirectTo = onServerPage
    ? null
    : auth.status === "signed-out" && !hasServerUrl()
      ? "server"
      : auth.status === "signed-out" && !onLoginPage
        ? "login"
        : auth.status === "signed-in" && onLoginPage
          ? "app"
          : null;

  useEffect(() => {
    if (redirectTo === "server") {
      router.replace("/server");
    } else if (redirectTo === "login") {
      const next = safeReturnPath(
        `${window.location.pathname}${window.location.search}`,
      );
      router.replace(
        next ? `/login?next=${encodeURIComponent(next)}` : "/login",
      );
    } else if (redirectTo === "app") {
      const params = new URLSearchParams(window.location.search);
      const next = safeReturnPath(params.get("next"));
      // Next.js のページは "/" だけなので、それ以外のパスへはブラウザーに移らせる
      // (配信する側が同じ画面を返す)。
      if (next) window.location.replace(next);
      else router.replace("/");
    }
  }, [redirectTo, router]);

  if (onServerPage) return <>{children}</>;

  if (auth.status === "unreachable") {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="font-semibold text-xl">サーバーに接続できません</h1>
        <p className="text-muted-foreground text-sm">
          ネットワークの状態を確認して、もう一度お試しください。
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={auth.retry}>
            再試行
          </Button>
          {isBundledApp() && (
            <Button variant="ghost" onClick={() => router.push("/server")}>
              接続先サーバーを変更
            </Button>
          )}
        </div>
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
