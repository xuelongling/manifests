<!-- SPDX-License-Identifier: MIT -->

# Upgrade governance report consumption

`manifest-ci.mjs gate --repository <fixture-manifests> --base <old-OID>
--head <new-OID> --upgrade-review-report <Build-Report.json> --out <fresh-dir>`
checks a report produced by the product's existing `tsfg-build build --dev
--source-target upgrade-review` target against the one changed manifest candidate.
Exact manifest bytes/OID, source approval, fixed commitments and necessary bound
evidence must agree. Rejected, stale, incomplete, real-source and Stable-marked
reports fail. A rollback report must describe the new rollback manifest, with
passed evidence for the accepted target identity.

The emitted `upgrade-governance.json` remains a governance fixture receipt with
`intakeComplete: false` and `promotionState: "Candidate"`. This optional fixture
lane is not a substitute for Workspace Verification or release proof. Existing
snapshot/tag protection, Owner-controlled promotion, and 90-day Candidate
evidence retention apply unchanged. Real-source upgrade proof is integrated by
R02a ticket 11; this lane never authorizes an official upstream upgrade.

Cross-repository regression: set `TSFG_MANIFEST_CI` to this checkout's absolute
`tools/manifest-ci.mjs`, redirect temporary storage to E:, and run the product's
locked Node with `--test tests/r00/upgrade-cli.test.mjs`. That test drives actual
Git commits and merges through the product control plane and this gate, including
rollback, refusal and fixture-only evidence checks. Run this repository's own
`node --test tests/*.test.mjs` suite as well.
