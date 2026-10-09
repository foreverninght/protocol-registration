-- Project restored candidate workflow state into the authoritative account snapshot.

begin;

update accounts account
set account_snapshot_json = account.account_snapshot_json || jsonb_strip_nulls(jsonb_build_object(
      'mailComStage', candidate.mail_com_stage,
      'mailComReleaseStatus', candidate.mail_com_release_status,
      'mailComReleaseError', candidate.mail_com_release_error,
      'gcashSold', candidate.gcash_sold
    )),
    lifecycle_stage = case candidate.mail_com_stage
      when 'eligibility' then 'eligibility'
      when 'refining' then 'refining'
      when 'gcash' then 'gcash'
      when 'sold' then 'sold'
      else account.lifecycle_stage
    end,
    version = account.version + 1,
    updated_at = greatest(account.updated_at, candidate.updated_at)
from registration_candidates candidate
where candidate.email = account.email
  and candidate.mailbox_source = 'mail_com_split'
  and (
    account.account_snapshot_json->>'mailComStage' is null
    or account.account_snapshot_json->>'mailComReleaseStatus' is null
  );

commit;
