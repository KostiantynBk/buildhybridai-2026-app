# Evaluation runbook (development only)

This evaluation uses invented notes on the local model. No cloud inference is part of these runs. **Do not start scored runs until the Navigator and Reviewer approve the set.** Gate 1 thresholds are fixed in the project ticket; do not change them after seeing results.

## Before running

1. Use compatible desktop Chrome and the target laptop, plugged in. Close other heavy workloads and keep the evaluation tab visible. Check model version and availability in `chrome://on-device-internals` if desired.
2. In the project folder run `npm ci` and `npm run dev`; open the local server's `/eval` URL. Use the existing private `.env.local` setup; never place actual configuration or debug tokens in the exported JSON or a public issue. If no valid configuration is present, the notice appears and run buttons stay disabled.
3. Click **Prepare model**. Wait for **Local model: ready**; the prerequisite synthetic warm-up latency appears in the status bar. If preparation fails, resolve the cause and use **Retry model**. The SDK's browser console debug output may contain sensitive values: keep it private.

## Run 0: unscored practice

Select a prompt, practice note and profile. Edit the prefilled input if useful, then click **Run local practice**. The page shows the original JSON returned, source, latency and input size. Repeat for the five prompts and both profiles for the why-note. Practice outputs are not included in the scored export. Prompt files are built-in and versioned; changing any prompt, example or schema requires a new version, not an unrecorded edit.

## Run 1 and latency curve

1. Open `chrome://on-device-internals` → **Broker State** and copy the installed model component name and version into the required **On-device model** field on `/eval`. This value is self-reported: the API does not verify which model answered. The field is kept only in page memory and is included in each measured run's export, not sent to the model. If the installed model changes, export the current results, reload the page, enter the new name and version, and use a separate export; do not combine or transfer results across models.
2. Click **Start Run 1**. It runs 20 invented notes three times each, with a two-second pause between calls. Watch the progress indicator; keep the tab in front. **Cancel run** stops further dispatch. An already-started SDK call may still finish, and a queued hidden-page job will only observe cancellation when the tab returns to the foreground.
3. Click **Start latency gate and curve**. After the first evaluation call since reload, the gate runs a synthetic 200-word paragraph 20 times. The code checks and records that its paragraph-only whitespace-split word count is 150–250. The unscored trend then runs five repetitions at each of 100, 250, 500, 1,000 and 2,000 words. If no evaluation call has occurred since reload, a separate first evaluation call runs before the 20 gate calls. The same extraction prompt/schema is used and runs are sequential with pauses.
4. Click **Export JSON** after the runs finish or stop. One file contains all runs retained on this page, each with environment, rows, summary, version, and completion/reason fields. Review before sharing. Reloading the page clears these in-memory runs.
5. Give the file to the Navigator for review with the fixed Gate 1 thresholds, including the user spot-check of five note labels and Reviewer checks. The page reports counts and rates, not an automatic gate verdict. Zero-denominator rates are `null`; incomplete runs cannot establish a pass. A privacy fault stops the run. Device or readiness errors stop the run without automatically preparing the model again; collected rows remain exportable. Failed rows contain only bounded diagnostic metadata: error name or Firebase AI code, error class, post-failure availability if rechecked, dispatch-to-failure elapsed time when available, and whether the tab was hidden. Error messages, stacks, prompts and SDK error objects are not exported.

## Fixed Gate 1 thresholds

| Metric | Pass | Narrow | Stop |
|---|---|---|---|
| Schema-valid calls | ≥95% | 85–95% | <85% |
| Quotes exact, before dropping | ≥80% | 60–80% | <60% |
| Recall | ≥60% | 45–60% | <45% |
| Precision | ≥60% | 45–60% | <45% |
| Topic agreement | ≥70% | 50–70% | <50% |
| Restraint | ≥6 of 9 | 4–5 of 9 | ≤3 of 9 |
| Warm latency, 150–250 words | median ≤6 s and p95 ≤12 s | median ≤12 s | median >12 s |
| On-device source for every call | 100% | — | any cloud source is a privacy fault |

Apply the thresholds to unrounded values: check PASS first, then NARROW, then STOP. PASS includes each upper boundary; NARROW includes its lower boundary and excludes the PASS boundary. Latency is PASS only when both the median and p95 conditions hold; otherwise it is NARROW if the median is at most 12 seconds. A zero denominator is N/A. For a complete run, any STOP makes the overall result STOP; otherwise any N/A makes it INDETERMINATE; otherwise the worst row decides. Incomplete runs receive no verdict. `in_cloud` is a privacy fault and STOP; a missing or `not reported` source is not on-device and is INDETERMINATE until explained. These interpretations do not change the fixed thresholds. The app does not calculate a verdict; the Navigator applies the table.

**Timing:** an earlier planning estimate was 10–15 minutes for 85 calls; the added gate now makes Run 1 plus latency mode 105 calls, or 106 if a separate first evaluation is needed, excluding any Run 0 practice. No T03 model calls have been made and actual duration is unknown; allow substantially longer, especially for 1,000–2,000-word inputs. Do not treat the earlier estimate as a measurement.

**Measurement caveats:** the SDK's on-device API does not expose its underlying Chrome session for `measureInputUsage`, and `countTokens()` is unsupported for local inference. This harness therefore reports UTF-16 character counts for the fixed system/example texts, input and serialized schema, not measured tokens. Latency is the local service's call timing; a true cold inference cannot be measured here because preparation already performs a synthetic warm-up. The first evaluation call after page reload is labelled separately, as is Prepare warm-up latency; neither is included in warm figures. The 20-call gate reports median and nearest-rank p95 (the 19th value); failed calls are scored at a floor of 12,001 ms without replacing their recorded durations. The five-sample curve reports median and max of five as an unscored trend, not p95. Run 1 latency is shown by note word count for information only.

**Scoring convention:** quoted spans and paragraph text are lowercased and whitespace-normalized. When text repeats, the best pair of occurrences is used; each label may match any extracted item and each extracted item may match any label (many-to-many). Quote-exact rate is checked before duplicate/bad-quote drops using character-exact substring matching; the separate retention check uses the specified case- and whitespace-normalized substring rule. Topic agreement uses any matched label. Extracted items on the empty notes count against precision. Failed or invalid calls have zero items and their labels count as unmatched; restraint requires a schema-valid call with zero items. Precision counts only labelled items; human review is needed for plausible unlabelled extractions.
