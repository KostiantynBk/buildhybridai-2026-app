# Scaffold notes

## Verified SDK facts

This project pins `firebase` 13.3.0, containing `@firebase/ai` 3.1.0. The installed `node_modules/@firebase/ai/dist/ai-public.d.ts` declares `getAI`, `GoogleAIBackend`, `getGenerativeModel`, `HybridParams`, `InferenceMode.ONLY_ON_DEVICE`, `OnDeviceParams.createOptions` / `.promptOptions`, `initializeDeviceModel(progress)` and optional `response.inferenceSource`. The on-device source string is `on_device`. `node_modules/@firebase/app-check/dist/app-check-public.d.ts` declares `initializeAppCheck` and `ReCaptchaEnterpriseProvider`.

The published [3.1.0 changelog](https://github.com/firebase/firebase-js-sdk/blob/firebase%4013.3.0/packages/ai/CHANGELOG.md) lists TTS speech metadata, a `getAI()` existing-instance options fix, and GoogleAI prompt-feedback mapping fix. It does **not** list an on-device or hybrid-specific change. The options fix is relevant to repeated AI initialization but does not establish a change in local inference.

Static inspection of `node_modules/@firebase/ai/dist/esm/index.esm.js`, `ChromeAdapterImpl.generateContent` / `createSession` around lines 1019 and 1162, shows a new Chrome session is created for each inference. `createSession` passes `onDeviceParams.createOptions` to `LanguageModel.create`, so its `initialPrompts` field is passed through if supplied. `generateContent` passes `onDeviceParams.promptOptions` to `session.prompt`, carrying `responseConstraint`. These are source observations, not a real inference test. The scaffold does not set `initialPrompts`.

`HybridParams.inCloudParams` is optional in `ai-public.d.ts`; the local-only path leaves it unset. The SDK internally defaults a cloud model name when omitted, so the application guard remains essential.

The same source's `chromeAdapterFactory` around 1224 and `callCloudOrDevice` around 2562 preserve the missing-adapter cloud-routing hazard: when `LanguageModel` is absent, the SDK can call cloud before considering `ONLY_ON_DEVICE`. This app checks the API before creating an adapter and immediately before every call, uses only `ONLY_ON_DEVICE`, then refuses to consume output whose actual source is not `on_device`. This guard cannot prove every browser/SDK behavior; a real on-device run and network inspection are still required.

## Dependencies and licences

Direct runtime dependencies: Firebase 13.3.0 (Apache-2.0), React 19.3.1 (MIT), React DOM 19.3.1 (MIT), Ajv 8.20.0 (MIT). Direct development dependencies: TypeScript 7.0.2 (Apache-2.0), Vite 8.3.8 (MIT), Vitest 5.1.0 (MIT), React type declarations 19.3.0 (MIT), React DOM type declarations 19.3.0 (MIT). No UI library was added. Installed lockfile license metadata also includes BSD-3-Clause, ISC, 0BSD and MPL-2.0; the MPL-2.0 entries are Lightning CSS build-tool packages and retain their separate file-level terms. Dependency metadata was checked, not an independent legal review of every transitive license.

## T03 evaluation

The five v1 prompt systems, examples, input templates and schema texts are copied from the pre-submission planning draft and fingerprint-tested; profiles and practice notes are unchanged copies. Firebase AI 13.3.0's `LanguageModelCreateOptions.initialPrompts` and `LanguageModelMessage` are declared in `node_modules/@firebase/ai/dist/ai-public.d.ts`, and the browser source's `ChromeAdapterImpl.createSession` passes create options through. The `Job` path carries the system and example turns to the Firebase local-only model; the existing config/API and actual-source guards remain in force.

The SDK does not expose the native on-device session for context measurement; on-device `countTokens` throws. The harness reports character counts, not tokens. Prepare warm-up and the first evaluation call after reload are reported separately, not included in warm figures. The 200-word gate uses 20 calls and nearest-rank p95; failed gate calls have a greater-than-12-second scoring floor. The 5-size, five-repetition curve reports an unscored max of five, not p95. The fixed gate table remains in the runbook; the app reports counts/rates rather than an automatic verdict. The Navigator has ruled on boundary, zero-denominator, source and matching interpretation before any scored run. Measured runs require a user-reported on-device component name and version from Chrome's Broker State; the value is stored in page memory, recorded per run, and never sent to the model. It is not API verification of the model that answered. Results from different models require separate exports and a page reload. No real evaluation has been run. `/eval` has not been clicked end-to-end with a fake model; it is covered by server-render and fake-run integration tests. The dataset has human-label gaps; all 20 notes need review.

## Readiness recovery

A user can retry preparation from an error or unavailable state. The click starts both the browser availability check and Firebase's preparation call without first awaiting either; the SDK itself checks availability before initiating a download (`node_modules/@firebase/ai/dist/esm/index.esm.js`, `downloadIfAvailable` near line 1072 and `initializeDeviceModel` near line 3310). This keeps the SDK invocation within the click handler, but actual Chrome transient-activation behavior remains untested. SDK/device failures during jobs trigger a fresh availability probe, invalidate ready and reject the job without retry. Parse, schema and privacy-source rejections do not trigger a probe. A foreground check loops immediately before dispatch; in-flight work is not cancelled.

The config placeholder list is compared with `.env.example` in a test. Only exact example values or blank/missing values are rejected; ordinary project names are allowed.

## Limitations and open questions

- No-config and placeholder routes deliberately permit only notebook/navigation and browser availability; Firebase is not initialized, Prepare is disabled and private work fails closed. In explicit development debug mode a site key is not needed. The public `CustomProvider` (`node_modules/@firebase/app-check/dist/app-check-public.d.ts`) fails closed if invoked; the installed App Check source (`dist/esm/index.esm.js`, token handling near 756 and provider initialization near 1394) routes debug exchanges separately and the custom provider does not initialize reCAPTCHA. The SDK's debug console warning still applies.
- The state `downloadable` also covers a browser model already reported `available`: readiness here means prepared and warmed through Firebase, not merely downloaded. The status bar separately shows the browser's exact availability.
- `npm audit --omit=dev` reported four high findings in the Firebase → Firestore/Firestore-compat → grpc dependency chain. Firestore is not imported by this app. Bundle exposure and exploitability were not assessed; do not blindly apply the suggested breaking downgrade.
- Real Firebase setup, App Check, Chrome downloads, warm-up and source verification have not been exercised in this ticket. The SDK debug provider may itself log a generated token and project identifiers; keep that console private.
- The notebook is browser `localStorage`, not durable IndexedDB; no multi-tab coordination, cloud research, profile storage, notebook-triggered extraction or deployment exists yet. No claim is made that the whole app is offline: browser model download and App Check may contact services.
- This is a FIFO within one page, not a cross-tab or durable queue. A queued job waits for a foreground page; in-flight work is not cancelled on hiding.
