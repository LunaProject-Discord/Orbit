import { ThemeToggle } from "@/components/theme-toggle";

export default function Home() {
  return (
    <main className="relative flex flex-1 flex-col items-center justify-center gap-3 p-8">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <h1 className="font-semibold text-4xl tracking-tight">Mail</h1>
      <p className="text-muted-foreground text-sm">
        メールアカウントを追加すると、ここに受信トレイが表示されます。
      </p>
    </main>
  );
}
