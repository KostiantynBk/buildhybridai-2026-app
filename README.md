# ThoughtPartner

## What it is and who it's for

ThoughtPartner is a planning notebook for solo builders who want another perspective before they write code. It can identify questions locally and research an approved public question, while keeping the relationship to the builder's assumptions visible.

## How it uses Firebase AI Logic

The application uses Firebase AI Logic for guarded on-device inference, optional cloud processing, and Search-grounded research of approved questions. Cloud processing requires a separate explicit opt-in; the app checks the reported inference source.

- The notebook, paragraph versions, extracted items, lineage versions, dependencies, profile and job queue stay in this browser's IndexedDB. In the default on-device mode, settled paragraphs use the guarded on-device Firebase AI Logic path. If an earlier quote disappears, `compare.v1` compares the earlier statement and quote against the edited paragraph on device. If you explicitly opt into cloud processing, those plan-processing inputs go to Gemini in the cloud. Code handles quote shortcuts, lineage and dependency staleness without new network calls. When a why-note is generated, selected profile records are used only in its on-device prompt; the separate never-send list is never sent to a model. The availability check runs in the browser; preparation includes a synthetic on-device warm-up.
- When you press Prepare, the app initializes Firebase and App Check. App Check may contact Google, and Chrome may download the local model from Google.
- Firebase Remote Config is the second Firebase product. On normal notebook startup, when Firebase is configured, it may contact Firebase Installations to register an installation or obtain an installation auth token, then Firebase Remote Config to fetch settings. The SDK creates a pseudonymous Firebase installation ID and sends it with app/SDK identifiers and browser language; the network provider also receives the connection's IP address. No notebook text or profile is passed to this SDK.
- Remote Config controls only the cloud-enabled flag, an allow-listed cloud-model ID, the bundled prompt-set ID and a daily cloud budget capped at 20. Invalid or unavailable values fall back to the built-in defaults. It cannot change local inference mode or guards, source checks, Outbox approval or App Check. Cloud processing and research are optional and require their respective consent. Evaluation runs use built-in settings and their own prompt selector, never fetched values.
- This app does not initialize Analytics or set user properties, custom signals, personalization or A/B tests. Do not configure those features for the project. A successful local source check is not a guarantee that all other app activity is offline.

The current Content Security Policy is **report-only**, not enforced: runtime Ajv validation uses dynamic code generation that a no-`unsafe-eval` policy would block. Do not enable enforcement until validation is made CSP-compatible and real browser checks pass.

## Try the demo

Hosted demo: **link pending deployment**. Desktop Chrome 157 was used for the local evaluation; a hosted demo has not yet been verified. The model may take time to download on first use; the duration depends on the connection and machine.

<!-- Navigator: confirm on Chrome 157 -->
For the evaluated Gemma 4 setup, enable `chrome://flags/#gemma4-for-built-in-ai`, restart Chrome, then enable `prompt_api_gemma4` in `chrome://on-device-internals` (enable debug pages at `chrome://chrome-urls` if needed). Confirm Broker State there. The setup is not Chrome's default and these exact steps await confirmation.
<!-- /Navigator -->

If the on-device model is unavailable, the app offers an explicit cloud-processing opt-in explaining what it sends. Search research has separate consent.

## Requirements

- Node.js 24.12.0 or newer and npm 11.
- Compatible desktop Chrome with the Prompt API and Gemini Nano available. Current documented prerequisites include 22 GB free disk space on the profile volume and either more than 4 GB GPU VRAM or at least 16 GB RAM and four CPU cores. Browser availability and the exact Nano version still need to be checked on the actual machine.
- A Firebase project and Web app configured for AI Logic and App Check for model preparation. Without configuration, the notebook and availability check still work but AI features are off.

## Run locally

1. Run `npm ci`.
2. For the notebook-only shell, run `npm run dev` and open the displayed localhost address. No configuration is required.
3. To prepare the model, create/configure a Firebase Web app for AI Logic with the Gemini Developer API and register it with App Check. Copy `.env.example` to `.env.local` and privately fill in the four Firebase values. A reCAPTCHA Enterprise site key is required except in explicit development debug mode. These are browser-visible configuration values; do not commit or share real values. Restart the development server after changes.
4. For private development only, optionally set `VITE_APPCHECK_DEBUG=true` and register the generated App Check debug token privately using the [Firebase debug guide](https://firebase.google.com/docs/app-check/web/debug-provider). The SDK itself may print the token and project/app identifiers to the browser console; keep the console private and never copy these values into an issue or submission. Production builds do not enable the debug provider and require a registered Enterprise site key.
5. Open desktop Chrome and check the status bar. An already downloaded `available` model is prepared automatically in the foreground; if a download is needed, press **Prepare model**. The app runs a synthetic local warm-up before marking the model ready. If preparation fails, or a device error occurs, use **Retry model** after resolving the cause.

Remote Config parameters are optional: the app works with no parameters defined. If desired, the project owner may configure `cloud_enabled`, `cloud_model`, `prompt_set` and `daily_cloud_budget` in the Firebase console; only supported, narrowing values are used. The application fetches once per startup with an eight-second SDK timeout and a ten-second application deadline, using a one-hour minimum fetch interval. A timeout returns built-in defaults; the underlying SDK may still finish an already-started operation. No real-time listener is used.

Existing notebook text from the earlier localStorage scaffold migrates once after a successful IndexedDB transaction; the old key is then removed. Paragraphs are separated by blank lines. Profile import and export are local JSON files and include the private never-send list; do not share them inadvertently. Names inside profile text are not detected automatically: add them to the explicit list. The filter catches listed terms, currency amounts, emails and URLs, not every private detail. Loading a demo or importing replaces the current profile after confirmation. In Profile, **Delete all local data** clears this app's notebook, versions, items, lineage and dependency records, comparison batches, jobs, profile and Outbox stores and removes the legacy notebook key after confirmation. It does not delete browser model downloads or separate Firebase SDK installation/configuration storage.

The console setup steps, Remote Config behavior against a real project and production App Check enforcement have not yet been verified. Deploying requires the project owner to authenticate and approve the deployment.

## Testing instructions

Run `npm run typecheck`, `npm test`, and `npm run build`. The tests use fakes and do not call a real model. With absent or example-only configuration, preparation is disabled and private inference returns a typed `not-configured` error. The development-only evaluation route and its pre-run requirements are documented in [eval/RUNBOOK.md](eval/RUNBOOK.md).

## What was built during the hackathon

This repository was started after the Submission Period began on 11 November 2026 at 13:30 Pacific Time. The current application includes a locally saved versioned notebook and profile, an on-device extraction queue, optional cloud processing and approved Search research, and tests. A development-only evaluation harness and synthetic scored set have been added; extract prompts have been evaluated on one laptop, while the newer notebook integration still needs a real end-to-end check. Further functionality is to be completed.

## History and disclosure

TBD by the owner. The five v1 prompt texts and the synthetic profiles and practice examples were written 9–11 November 2026 before the submission period and copied from planning materials. The unchanged synthetic demo-profile file is copied into the profile feature; its original none/some/strong skill depths are mapped to new/some/deep when loaded. The scored evaluation notes, labels, change pairs and evaluation code were written during the submission period. Additional disclosure is to be completed by the owner.

## Licence

Apache License 2.0; see [LICENSE](LICENSE).
