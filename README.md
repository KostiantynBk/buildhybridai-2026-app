# ThoughtPartner

## What it is and who it's for

ThoughtPartner is a planning notebook for solo builders who want another perspective before they write code. Its intended design is to identify questions locally and research only an approved public question, while keeping the relationship to the builder's assumptions visible. This repository currently contains a scaffold: the notebook works, while side thoughts and research are not implemented.

## How it uses Firebase AI Logic

The scaffold uses Firebase AI Logic's web hybrid interface for model preparation and a small synthetic local warm-up, with a checked `ONLY_ON_DEVICE` path and the reported inference source verified. It does not yet run notebook analysis or cloud inference.

- The notebook text stays in this browser's local storage. The availability check runs in the browser; the synthetic warm-up and future guarded local inference run on-device through Firebase AI Logic.
- When you press Prepare, the app initializes Firebase and App Check. App Check may contact Google, and Chrome may download the local model from Google.
- This scaffold makes no cloud inference call. A successful source check is not a guarantee that all other app activity is offline.

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

The console setup steps and production App Check enforcement have not been verified in this scaffold. No deployment or billing setup is included.

## Testing instructions

Run `npm run typecheck`, `npm test`, and `npm run build`. The tests use fakes and do not call a real model. With absent or example-only configuration, preparation is disabled and private inference returns a typed `not-configured` error. The development-only evaluation route and its pre-run requirements are documented in [eval/RUNBOOK.md](eval/RUNBOOK.md).

## What was built during the hackathon

This repository was started after the Submission Period began on 11 November 2026 at 13:30 Pacific Time. The current scaffold includes a locally saved notebook, placeholder panels, a readiness interface, guarded local Firebase AI Logic service, and tests. A development-only evaluation harness and synthetic scored set have been added; real evaluation is still to be performed. Further functionality is to be completed.

## History and disclosure

TBD by the owner. The five v1 prompt texts and the synthetic profiles and practice examples were written 9–11 November 2026 before the submission period and copied from planning materials. The scored evaluation notes, labels, change pairs and evaluation code were written during the submission period. Additional disclosure is to be completed by the owner.

## Licence

Apache License 2.0; see [LICENSE](LICENSE).
