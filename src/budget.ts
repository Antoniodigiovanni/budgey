export type BudgetState = {
  household: { starting_funds: number };
  categories: any[];
  targets: any[];
  allocations: any[];
  transactions: any[];
};
export function calculate(state: BudgetState, month: string) {
  const year = Number(month.slice(0, 4));
  const end = month + "-31";
  const tx = state.transactions.filter((t) => !t.voided);
  const allocations = state.allocations;
  let released = 0;
  const categories = state.categories.map((c) => {
    const spending = (m: string) =>
      tx
        .filter((t) => t.date.startsWith(m))
        .reduce(
          (n, t) =>
            n +
            (t.kind === "expense" ? 1 : t.kind === "refund" ? -1 : 0) *
              t.splits
                .filter((s: any) => s.category_id === c.id)
                .reduce((v: number, s: any) => v + s.amount, 0),
          0,
        );
    const assigned = (m: string) =>
      allocations
        .filter((a) => a.category_id === c.id && a.month.startsWith(m))
        .reduce((n, a) => n + a.amount, 0);
    const months = [
      ...new Set([
        ...allocations.map((a) => a.month.slice(0, 7)),
        ...tx.map((t) => t.date.slice(0, 7)),
        month,
      ]),
    ]
      .filter((m) => m <= month)
      .sort();
    let balance = 0,
      start = 0;
    for (const m of months) {
      if (!c.rollover) {
        released += balance;
        balance = 0;
      }
      if (m === month) start = balance;
      balance += assigned(m) - spending(m);
    }
    const planned = allocations
      .filter((a) => a.category_id === c.id && a.month.startsWith(String(year)))
      .reduce((n, a) => n + a.amount, 0);
    const actual = tx
      .filter((t) => t.date.startsWith(String(year)))
      .reduce(
        (n, t) =>
          n +
          (t.kind === "expense" ? 1 : t.kind === "refund" ? -1 : 0) *
            t.splits
              .filter((s: any) => s.category_id === c.id)
              .reduce((n: number, s: any) => n + s.amount, 0),
        0,
      );
    const target =
      state.targets.find((t) => t.category_id === c.id && t.year === year)
        ?.amount ?? 0;
    return {
      ...c,
      start,
      assigned: assigned(month),
      spent: spending(month),
      available: balance,
      planned,
      actual,
      target,
      warnings: [
        ...(balance < 0 ? ["Overspent"] : []),
        ...(planned > target ? ["Plan above target"] : []),
        ...(actual > target ? ["Spending above target"] : []),
      ],
    };
  });
  return {
    categories,
    unassigned:
      state.household.starting_funds +
      tx
        .filter((t) => t.kind === "income" && t.date <= end)
        .reduce((n, t) => n + t.amount, 0) -
      allocations
        .filter((a) => a.month <= end)
        .reduce((n, a) => n + a.amount, 0) +
      released,
    spent: categories.reduce((n, c) => n + c.spent, 0),
    assigned: categories.reduce((n, c) => n + c.assigned, 0),
    available: categories.reduce((n, c) => n + c.available, 0),
  };
}
