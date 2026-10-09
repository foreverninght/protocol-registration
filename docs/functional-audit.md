# Registration workflow functional audit

This audit covers the single `freepp` registration profile. It precedes the publication review. Production services and original FreePP source directories were not modified.

## Validation boundary

The browser, HTTP application, PostgreSQL stores, migrations, queue, runner, Python subprocess IPC and mailbox poller are exercised locally. Mailbox messages, credentials, proxy checks and upstream registration responses are controlled fixtures. These checks establish local workflow behavior, not current acceptance or success rates at an external registration service. No real accounts are created by these tests.

## Findings and verified remediation

| Finding | Impact | Regression coverage |
| --- | --- | --- |
| Eligibility proxy panel hidden by capability filter | Operators could not configure the retained eligibility pool in the UI | `registration-profile-ui.test.js`, real browser CRUD |
| Batch credential export lock retained after every read failed | Later export attempts did nothing | `batch-credential-export.test.js`, browser empty-result and recovery cases |
| Unauthenticated HTTP proxy URLs rejected | A common proxy format imported zero entries | `proxy-url-import.test.js`, browser import and equivalent-format deduplication |
| Startup recovered another worker's unexpired lease | One account could run concurrently in two workers | `registration-lease-postgres.test.js` |
| Old lease owner could write progress or failure | A stale worker could corrupt its successor's result | Database fencing with worker ID and claim attempt, runner lease-loss regressions |
| Stopped controller admitted successor jobs | Shutdown could start more registrations while dependencies closed | `registration-control-stop.test.js` |
| Automatic credential repair ignored mailbox viability | Expired or undeliverable inboxes consumed repair capacity | Database creation and claim gate regressions |
| Ordinary password setup referenced uninitialized repair state | Password setup failed before being called and TOTP was skipped | `test_freepp_bridge_contracts.py` |
| TOTP activation or confirmation errors lost the enrollment secret | The remote account could require a secret absent locally | Partial credential persistence and saved-secret recovery regressions |
| Final token validation or strict email-change failure discarded prior results | Already-created passwords and TOTP credentials could be lost, hidden by a successful projection or retried as registration | Partial-result IPC, real database recovery and failed-state projection regressions |
| Existing password confused with verified stored password | An incorrect password could be exported as usable | Password-required login and bridge failure regressions |
| OTP timeout bypassed core resend logic | Two-phase login/repair waits ended without resending | `freepp-real-ipc-contracts.test.js` |
| Mail polling continued after sidecar termination | Stale requests and events outlived the task | IPC timeout and cancellation regressions |
| Configured post-registration delay exceeded idle timeout | Valid long delays were terminated early | Waiting-stage heartbeat regression |
| Password normalization changed credential contents | Passwords with leading/trailing whitespace stopped matching | Bridge/core, import and database round-trip regressions |

## Batch workflow coverage

`batch-registration-postgres.test.js` uses isolated, disposable databases. It checks three concurrent accounts through candidate import, job creation, queue claims, automatic code retrieval, proxy retry, complete account/session persistence and monotonically ordered events. A separate case checks twelve independent claimers for duplicate execution admission. These tests require a loopback `SIGNLIST_TEST_DATABASE_URL` whose user may create disposable databases.

Browser checks cover the actual visible panels, proxy pool create/import/select/delete, duplicate mailbox imports, concurrency settings, password/TOTP/session switches, batch credential copy and recovery after empty export responses. Browser checks keep the registration task table empty; actual batch execution is tested separately with controlled upstream responses.

## Shutdown and export semantics

Stopping automatic generation stops adding automatic candidates; previously queued and running jobs may finish. Stopping the service controller prevents new execution admission and waits for work already in flight to settle before its close callback completes. This does not undo an external request already sent.

The formatted account export requires a usable password and TOTP secret. Accounts registered without these optional steps retain their saved tokens and sessions, but are not represented as complete password/TOTP exports.

## Final verification

The final audited revision passed 281 Node tests with real local PostgreSQL and zero skips, 24 Python dependency/bridge/archive tests, 71 shared-worker tests, the JavaScript syntax checks and nine groups of browser functional checks. All 15 migrations were applied and then run again successfully. The temporary PostgreSQL instance was stopped after validation.

Changed-email recovery also passed real Node/Python IPC tests with controlled upstream HTTP responses: saved private mailbox context routes OTP to the new inbox, excludes historical codes and leaves the old inbox provider unused. Public account views do not expose the private session context. Historical accounts without that saved context report an explicit mailbox-routing error rather than polling the old inbox.

Worker fencing prevents stale local database writes; it cannot undo an upstream operation already sent or make external services participate in the local database transaction. The server controller waits for active tasks, but the process signal handler retains a 20-second forced-exit deadline. Work not finished within that deadline crosses the forced-termination recovery boundary; it is not a guarantee that every remote operation finishes before process exit.

Publication review follows separately in `release-audit.md`. Any subsequent implementation changes require the affected regressions to be rerun before archiving.
