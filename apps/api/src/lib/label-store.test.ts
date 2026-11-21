import { describe, expect, it } from "vitest";
import { type MailboxRole, planLabelMove } from "./label-store.js";

const at = (...roles: MailboxRole[]) => roles.map((role) => ({ role }));
const roles = (plan: { sources: { role: MailboxRole }[] }) =>
  plan.sources.map((item) => item.role);

describe("planLabelMove", () => {
  it("アーカイブは受信トレイから外すだけで、ほかのラベルは残す", () => {
    const plan = planLabelMove(at("inbox", null, "all"), "all");
    expect(roles(plan)).toEqual(["inbox"]);
    expect(plan.removeLocally).toBe(true);
  });

  it("受信トレイに無いメールのアーカイブは何もしない", () => {
    expect(roles(planLabelMove(at(null, "all"), "all"))).toEqual([]);
  });

  it("ごみ箱と迷惑メールへは全部の所在を対象にする", () => {
    expect(roles(planLabelMove(at("inbox", null, "all"), "trash"))).toEqual([
      "inbox",
      null,
      "all",
    ]);
    expect(roles(planLabelMove(at("sent", "all"), "junk"))).toEqual([
      "sent",
      "all",
    ]);
  });

  it("ラベルへの移動は受信トレイを優先して移動元にする", () => {
    expect(roles(planLabelMove(at("all", null, "inbox"), null))).toEqual([
      "inbox",
    ]);
  });

  it("ごみ箱から受信トレイへ戻す", () => {
    expect(roles(planLabelMove(at("trash"), "inbox"))).toEqual(["trash"]);
  });

  it("受信トレイに無ければ、付いているラベルから移す", () => {
    expect(roles(planLabelMove(at("all", null, null), null))).toEqual([
      null,
      null,
    ]);
  });

  it("アーカイブ済みのメールは「すべてのメール」から移し、手元の所在は残す", () => {
    const plan = planLabelMove(at("all"), "inbox");
    expect(roles(plan)).toEqual(["all"]);
    expect(plan.removeLocally).toBe(false);
    expect(planLabelMove(at("sent", "all"), null).removeLocally).toBe(false);
  });
});
