import type { LedgerRole } from "@/lib/supabase/queries/ledgers";

/**
 * SAYING WHAT A BALANCE MEANS, IN THE WORDS THE LEDGER'S KIND DESERVES.
 *
 * A signed balance is Dr when positive and Cr when negative, everywhere in
 * this app. That is the correct and complete answer, and it is also the one
 * answer a shopkeeper cannot read — so the phone screens translate it.
 *
 * The translation is only available for parties. "They owe you" is a true
 * sentence about a customer and a meaningless one about your own cash
 * drawer: ₹5,000 in hand is not somebody's debt, it is money in a box. The
 * first version of the mobile ledger list said "they owe" under Cash in Hand
 * for exactly this reason — it read the sign and ignored the kind.
 *
 * So the kind decides:
 *   - customers and suppliers get the sentence, and which sentence depends
 *     on the sign: a customer in credit has paid in advance, so the debt runs
 *     the other way, and a supplier in debit likewise.
 *   - cash and bank get no sentence at all, because none is needed — except
 *     when the balance is negative, which for a bank account is an overdraft
 *     and worth naming.
 *   - everything else keeps Dr/Cr. An income head or a capital account has no
 *     everyday phrasing that isn't a lie, and inventing one would be worse
 *     than the accounting word.
 */
export interface BalancePhrase {
  /** Always positive — the sign is carried by the caption, not the figure. */
  amount: number;
  /** The words under the figure, or null when the figure speaks for itself. */
  caption: string | null;
  /** Whether this is money owed by the business (or an overdraft). */
  isLiability: boolean;
}

export function balancePhrase(balance: number, role: LedgerRole): BalancePhrase {
  const amount = Math.abs(balance);
  // Nil is nil, whatever kind of ledger it is: no direction to describe.
  if (balance === 0) return { amount: 0, caption: null, isLiability: false };

  const isDebit = balance > 0;

  switch (role) {
    case "debtor":
      // Dr: the ordinary case, they have not paid yet.
      // Cr: they paid more than they owed, so the money is theirs, not yours.
      return isDebit
        ? { amount, caption: "they owe", isLiability: false }
        : { amount, caption: "advance received", isLiability: true };

    case "creditor":
      // Cr: the ordinary case, the bill is unpaid.
      // Dr: you paid ahead, so it is owed back to you.
      return isDebit
        ? { amount, caption: "advance paid", isLiability: false }
        : { amount, caption: "you owe", isLiability: true };

    case "cash_bank":
      // Money you hold needs no caption. Money you are past the end of does.
      return isDebit
        ? { amount, caption: null, isLiability: false }
        : { amount, caption: "overdrawn", isLiability: true };

    default:
      // Income, expense, capital, loans, fixed assets: the accounting word is
      // the only honest one.
      return { amount, caption: isDebit ? "Dr" : "Cr", isLiability: false };
  }
}
