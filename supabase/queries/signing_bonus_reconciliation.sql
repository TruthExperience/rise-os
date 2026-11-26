-- Contracts that owe a signing-bonus debit that never happened.
--
-- debit_signing_bonus() deliberately warns instead of raising when the
-- contract's division has no wallet for that season, so a signing can never be
-- blocked by missing setup. Those skipped debits are real money that has not
-- left the wallet yet; this lists them so they can be collected (or waived)
-- once the wallet exists.
--
-- Read-only. Run against pitboss.
--
-- wallet_now_exists = true  -> the wallet has since been created; the debit can
--                              be posted now (one wallet_transactions row of
--                              type contract_signing, plus the balance update).
-- wallet_now_exists = false -> still no wallet; fix the division's wallet first.

select
  c.id                                              as contract_id,
  c.driver_id,
  c.franchise_id,
  l.slug                                            as league_slug,
  c.division,
  c.season_start,
  c.contract_value,
  c.signing_bonus,
  c.status,
  c.created_at,
  exists (
    select 1
      from pitboss.franchise_wallets w
     where w.franchise_id = c.franchise_id
       and w.league_id = c.league_id
       and w.division = c.division
       and pitboss.season_num(w.season) = pitboss.season_num(c.season_start)
  )                                                 as wallet_now_exists
from pitboss.driver_contracts c
join rise_os.leagues l on l.id = c.league_id
where coalesce(c.signing_bonus, 0) > 0
  and c.contract_value is not null          -- stubs pay nothing
  and not exists (
    select 1
      from pitboss.wallet_transactions wt
     where wt.related_id = c.id
       and wt.related_type = 'contract'
       and wt.transaction_type = 'contract_signing'
  )
order by wallet_now_exists desc, l.slug, c.division, c.created_at;

-- Note: contracts signed before the trigger existed also appear here. If you
-- only want post-migration gaps, add:
--   and c.created_at >= '2026-11-25'
