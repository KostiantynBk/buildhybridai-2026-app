# ThoughtPartner

## What it is and who it's for

ThoughtPartner is a planning notebook for solo builders who want another perspective before they write code. Its intended design is to identify questions locally and research only an approved public question, while keeping the relationship to the builder's assumptions visible. This version saves a notebook and profile locally and extracts plan items on device; researched side thoughts are not implemented.

## How it uses Firebase AI Logic

The application uses Firebase AI Logic's web hybrid interface for model preparation, a synthetic local warm-up and paragraph extraction, with a checked `ONLY_ON_DEVICE` path and the reported inference source verified. It does not yet run cloud inference.

- The notebook, paragraph versions and extracted items, profile and job queue stay in this browser's IndexedDB. Once a paragraph settles, its text and a generic title are passed only to the guarded on-device Firebase AI Logic extraction path. The profile is never sent to any model in this version. The availability check runs in the browser; preparation includes a synthetic on-device warm-up.
- When you press Prepare, the app initializes Firebase and App Check. App Check may contact Google, and Chrome may download the local model from Google.
- Firebase Remote Config is the second Firebase product. On normal notebook startup, when Firebase is configured, it may contact Firebase Installations to register an installation or obtain an installation auth token, then Firebase Remote Config to fetch settings. The SDK creates a pseudonymous Firebase installation ID and sends it with app/SDK identifiers and browser language; the network provider also receives the connection's IP address. No notebook text or profile is passed to this SDK.
- Remote Config controls only the cloud-enabled flag, an allow-listed cloud-model ID, the bundled prompt-set ID and a daily cloud budget capped at 20. Invalid or unavailable values fall back to the built-in defaults. It cannot change local inference mode or guards, source checks, Outbox approval or App Check. These cloud settings are scaffolding for later tickets; this version makes no cloud inference call. Evaluation runs use built-in settings and their own prompt selector, never fetched values.
- This app does not initialize Analytics or set user properties, custom signals, personalization or A/B tests. Do not configure those features for the project. A successful local source check is not a guarantee that all other app activity is offline.

## Requirements

- Node.js 24.12.0 or newer and npm 11.
- Compatible desktop Chrome with the Prompt API and Gemini Nano available. Current documented prerequisites include 22 GB free disk space on the profile volume and either more than 4 GB GPU VRAM or at least 16 GB RAM and four CPU cores. Browser availability and the exact Nano version still need to be checked on the actual machine.
- A Firebase project and Web app configured for AI Logic and App Check for model preparation. Without configuration, the notebook and availability check still work but AI features are off.

## Setup and run

1. Run `npm ci`.
2. For the notebook-only shell, run `npm run dev` and open the displayed localhost address. No configuration is required.
3. To prepare the model, create/configure a Firebase Web app for AI Logic with the Gemini Developer API and register it with App Check. Copy `.env.example` to `.env.local` and privately fill in the four Firebase values. A reCAPTCHA Enterprise site key is required except in explicit development debug mode. These are browser-visible configuration values; do not commit or share real values. Restart the development server after changes.
4. For private development only, optionally set `VITE_APPCHECK_DEBUG=true` and register the generated App Check debug token privately using the [Firebase debug guide](https://firebase.google.com/docs/app-check/web/debug-provider). The SDK itself may print the token and project/app identifiers to the browser console; keep the console private and never copy these values into an issue or submission. Production builds do not enable the debug provider and require a registered Enterprise site key.
5. Open desktop Chrome, check the status bar and press **Prepare model**. The browser may download a model. The app runs a synthetic local warm-up before marking the model ready; the first run on the target hardware is still to be verified. If preparation fails or the model becomes unavailable, use **Retry model** after resolving the cause.

Remote Config parameters are optional: the app works with no parameters defined. If desired, the project owner may configure `cloud_enabled`, `cloud_model`, `prompt_set` and `daily_cloud_budget` in the Firebase console; only supported, narrowing values are used. The application fetches once per startup with an eight-second SDK timeout and a ten-second application deadline, using a one-hour minimum fetch interval. A timeout returns built-in defaults; the underlying SDK may still finish an already-started operation. No real-time listener is used.

Existing notebook text from the earlier localStorage scaffold migrates once after a successful IndexedDB transaction; the old key is then removed. Paragraphs are separated by blank lines. Profile import and export are local JSON files. Loading a demo or importing replaces the current profile after confirmation. In Profile, **Delete all local data** clears this app's notebook, versions, items, jobs, profile and Outbox stores and removes the legacy notebook key after confirmation. It does not delete browser model downloads or separate Firebase SDK installation/configuration storage.

The console setup steps, Remote Config behavior against a real project and production App Check enforcement have not been verified in this version. No deployment or billing setup is included.

## Testing instructions

Run `npm run typecheck`, `npm test`, and `npm run build`. The tests use fakes and do not call a real model. With absent or example-only configuration, preparation is disabled and private inference returns a typed `not-configured` error. The development-only evaluation route and its pre-run requirements are documented in [eval/RUNBOOK.md](eval/RUNBOOK.md).

## What was built during the hackathon

This repository was started after the Submission Period began on 11 November 2026 at 13:30 Pacific Time. The current application includes a locally saved versioned notebook, local profile, on-device extraction queue, placeholder panels, a readiness interface, guarded local Firebase AI Logic service, and tests. A development-only evaluation harness and synthetic scored set have been added; extract prompts have been evaluated on one laptop, while the newer notebook integration still needs a real end-to-end check. Further functionality is to be completed.

## History and disclosure

TBD by the owner. The five v1 prompt texts and the synthetic profiles and practice examples were written 9–11 November 2026 before the submission period and copied from planning materials. The unchanged synthetic demo-profile file is copied into the profile feature; its original none/some/strong skill depths are mapped to new/some/deep when loaded. The scored evaluation notes, labels, change pairs and evaluation code were written during the submission period. Additional disclosure is to be completed by the owner.

## Licence

Apache License 2.0; see [LICENSE](LICENSE).
