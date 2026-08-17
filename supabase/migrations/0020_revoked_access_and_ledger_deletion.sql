-- Two security fixes. They are unrelated in mechanism and share only their
-- shape: in both, a rule the application states in one place is not enforced
-- on the other route that reaches the same data.

-- ============================================================== GAP 1 ======
-- Fix: a revoked member could let themselves back in with their old invite
-- link.
--
-- Revoking a membership sets company_members.status = 'revoked' and does
-- nothing else. Any invite already sent to that person stays 'pending', its
-- token stays live until expires_at (14 days by default), and
-- accept_company_invite() (0002) ends with:
--
--   insert into public.company_members (company_id, user_id, role, status, invited_by)
--   values (v_invite.company_id, auth.uid(), v_invite.role, 'active', v_invite.invited_by)
--   on conflict (company_id, user_id) do update
--     set role = excluded.role, status = 'active';
--
-- `status = 'active'` on the conflict path is the whole problem: it does not
-- ask what the existing row said. A user invited as an accountant, revoked
-- before they ever clicked the link, can click it afterwards and the upsert
-- puts them back at the invited role — silently, with no admin involved, and
-- with app_private.is_company_member() answering true from that moment on.
-- Revocation, the one control an admin has for removing someone, was
-- undone by a link that person already had in their inbox.
--
-- Both halves are fixed, because either alone leaves a window:
--
--   * expiring the invites closes the ordinary case, but not an invite issued
--     and revoked in a way that crosses the two statements, and not an invite
--     row that somehow survives (a restore from a backup taken before the
--     revocation would bring pending invites back with it);
--   * re-checking at redemption closes the general case, but leaves a live
--     token pointing at a company the user has been removed from, which is
--     the wrong thing to leave lying around whatever it does when clicked.
--
-- One consequence to be aware of, and it is a real trade-off rather than an
-- oversight: re-inviting somebody who was revoked no longer works on its own.
-- The membership row survives revocation, so the second half below refuses the
-- redemption no matter how fresh the invite is. An admin has to restore the
-- membership (or delete the row) as well as send the invite. That is the
-- conservative reading — "revoked" should not be undoable by anyone but an
-- admin acting deliberately on the membership itself — and the message says
-- so in as many words, but it is a change to how re-inviting behaves and it
-- belongs in release notes, not just in a migration comment.

-- ------------------------------------ 1a. revocation takes the invites down

-- The invite is matched by email, not by user id, because that is the only
-- thing company_invites carries — it is deliberately email-based so it works
-- before the invitee has an account at all (0002). lower() on both sides,
-- matching company_invites_pending_unique_idx and the select policy.
--
-- 'revoked', not 'expired': the clock did not run out, a person took the
-- access away, and the table's check constraint has a word for that. Either
-- value would work mechanically — accept_company_invite() only tests for
-- 'pending', and company_invites_pending_unique_idx is a partial index on
-- status = 'pending' so either frees the slot for a fresh invite — but the
-- history is worth reading correctly later.
--
-- security definer: the trigger has to read auth.users, which the calling
-- role has no grant on, and has to write company_invites rows that the
-- calling admin's own policies would permit anyway.
create or replace function app_private.expire_invites_on_member_revoked()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.company_invites i
  set status = 'revoked'
  where i.company_id = new.company_id
    and i.status = 'pending'
    and lower(i.email) = lower((select u.email from auth.users u where u.id = new.user_id));

  return null; -- AFTER trigger; the return value is ignored
end;
$$;

-- AFTER, not BEFORE: the membership change is the fact, and the invites follow
-- from it. `update of status` plus the WHEN clause keeps this off every
-- ordinary membership edit — it runs only on the transition into 'revoked',
-- once, and not again if the row is rewritten while already revoked.
--
-- Deliberately not fired on DELETE of a membership row. Deleting a member is
-- not the same statement as revoking one: it says "this person was never
-- here", and an admin who deletes the row and re-sends the link is doing
-- exactly what the re-invite flow expects. Only the revoked state is sticky.
drop trigger if exists expire_invites_on_member_revoked on public.company_members;

create trigger expire_invites_on_member_revoked
  after update of status on public.company_members
  for each row
  when (new.status = 'revoked' and old.status is distinct from 'revoked')
  execute function app_private.expire_invites_on_member_revoked();

-- --------------------------------- 1b. redemption re-checks the membership

-- Body taken from 0002, with one block added between the email check and the
-- upsert. Everything else is unchanged: security definer, set search_path
-- = '', the (uuid) -> uuid signature, the `for update` on the invite row, and
-- the order of the four existing checks.
--
-- The `for update` on the invite is also what serialises this against a
-- concurrent revocation: 1a's trigger has to update that same pending invite
-- row, so a revoke that starts while a redemption is in flight blocks until
-- the redemption commits or rolls back, and the two cannot interleave between
-- the check below and the upsert underneath it. The membership row is locked
-- too, for the case where the invite row is not the contended one.
--
-- create or replace preserves the function's ACL, so 0008's
-- revoke-from-public / grant-to-authenticated on accept_company_invite(uuid)
-- still stands and is not restated here.
create or replace function public.accept_company_invite(p_token uuid)
returns uuid
language plpgsql
security definer set search_path = ''
as $$
declare
  v_invite public.company_invites;
  v_user_email text;
  v_member_status text;
begin
  if auth.uid() is null then
    raise exception 'Must be authenticated to accept an invite';
  end if;

  select * into v_invite from public.company_invites where token = p_token for update;

  if v_invite is null then
    raise exception 'Invite not found';
  end if;
  if v_invite.status <> 'pending' then
    raise exception 'Invite is no longer pending';
  end if;
  if v_invite.expires_at < now() then
    update public.company_invites set status = 'expired' where id = v_invite.id;
    raise exception 'Invite has expired';
  end if;

  select email into v_user_email from auth.users where id = auth.uid();
  if lower(v_user_email) is distinct from lower(v_invite.email) then
    raise exception 'This invite was sent to a different email address';
  end if;

  -- The upsert below sets status = 'active' unconditionally, so without this
  -- an invite is a way back into a company somebody has been removed from.
  -- Restoring a revoked member is an admin's decision about the membership,
  -- not a side effect of a link being clicked.
  select status into v_member_status
    from public.company_members
    where company_id = v_invite.company_id and user_id = auth.uid()
    for update;

  if v_member_status = 'revoked' then
    raise exception 'Your access to this company was revoked, so this invite cannot be used. Ask an admin to restore your access.';
  end if;

  insert into public.company_members (company_id, user_id, role, status, invited_by)
  values (v_invite.company_id, auth.uid(), v_invite.role, 'active', v_invite.invited_by)
  on conflict (company_id, user_id) do update
    set role = excluded.role, status = 'active';

  update public.company_invites
    set status = 'accepted', accepted_by = auth.uid(), accepted_at = now()
    where id = v_invite.id;

  return v_invite.company_id;
end;
$$;

-- ============================================================== GAP 2 ======
-- Fix: an accountant could change a ledger's opening balance by deleting the
-- ledger and creating it again.
--
-- app_private.protect_ledger_financial_fields() (0003) is the rule that
-- opening balances are admin-only, and it is a BEFORE UPDATE trigger:
--
--   create trigger protect_ledger_financial_fields
--     before update on public.ledgers
--
-- Nothing guards DELETE, and the ledgers_delete policy (0005) admits anyone
-- can_write_company() lets through — which is every accountant:
--
--   create policy ledgers_delete on public.ledgers for delete
--     using ((select app_private.can_write_company(company_id)));
--
-- and ledgers_insert admits the same people, with no restriction on the
-- opening balance they set. So the two-step delete-then-recreate does exactly
-- what the update trigger exists to forbid, at whatever figure the accountant
-- chooses, and the audit log records it as a deletion and an unrelated
-- creation rather than as a changed balance.
--
-- The exposure is narrower than it first looks, and worse for it. A ledger
-- that has been posted to cannot be deleted at all — voucher_entries has a
-- foreign key on (ledger_id, company_id) with no ON DELETE action, so the
-- delete is refused. What is left deletable is precisely the untransacted
-- ledger, which is exactly where an opening balance lives: a balance brought
-- forward from the previous books, on an account nothing has moved through
-- yet. The one case the FK does not cover is the only case that matters.
--
-- The fix mirrors 0003 rather than inventing a second rule: if the ledger
-- carries a non-zero opening balance, only an admin may delete it. A ledger
-- at nil is deleted by an accountant as freely as before — there is no
-- financial fact to protect and tidying up the chart of accounts is ordinary
-- bookkeeping work.
--
-- Scope and interactions:
--
--   * a separate trigger, on DELETE only. 0017 added
--     protect_ledger_deactivation as BEFORE UPDATE OF is_active and 0003's
--     protect_ledger_financial_fields is BEFORE UPDATE; BEFORE ROW triggers
--     fire in alphabetical order, and protect_ledger_deletion sorts between
--     those two — but it is registered for a different event, so it never
--     runs in the same pass as either and the order is moot. Nothing is
--     folded into the existing functions, which would have made a DELETE
--     guard depend on OLD/NEW handling written for UPDATE.
--   * `is not true`, not `not ...`: is_company_admin() answers false rather
--     than NULL since 0015, but 0014, 0013 and 0015 all write the guard this
--     way so that a future NULL cannot turn `not NULL` into a skipped raise.
--   * the test is the opening balance alone, not the ledger's live balance.
--     A live balance implies posted entries, and posted entries already make
--     the row undeletable through the foreign key.
--   * restore_company_backup() (0013) deletes every ledger in the company on
--     its overwrite path, and revert_company_changes_since() (0014) deletes
--     ledgers whose creation it is undoing. Both refuse to run for anyone but
--     an admin before they get that far, so both pass this guard unchanged.
--
-- One known consequence, stated rather than special-cased: companies.id is
-- referenced ON DELETE CASCADE from ledgers, and a cascaded delete still fires
-- row triggers. Deleting a whole company row therefore hits this guard, and
-- fails unless the caller is an admin of the company being deleted — which,
-- for someone working directly against the database with no JWT, they are not.
-- Nothing in the application deletes a company (0005 gives companies no delete
-- policy at all, by design), so this is only reachable with direct database
-- access, where the trigger can be disabled for the duration. The alternative
-- — waiving the guard whenever auth.uid() is null — would make "no JWT" a way
-- around it, and 0003 set the precedent of not doing that.
create or replace function app_private.protect_ledger_deletion()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  if coalesce(old.opening_balance_amount, 0) <> 0
     and app_private.is_company_admin(old.company_id) is not true then
    raise exception
      'Only an admin can delete ledger "%": it carries an opening balance of % %. Ask an admin, or have them clear the opening balance to nil first.',
      old.name,
      old.opening_balance_amount,
      case when old.opening_balance_type = 'debit' then 'Dr' else 'Cr' end;
  end if;

  return old;
end;
$$;

drop trigger if exists protect_ledger_deletion on public.ledgers;

create trigger protect_ledger_deletion
  before delete on public.ledgers
  for each row execute function app_private.protect_ledger_deletion();
