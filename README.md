# Koyokana Studio

The control room for the Koyokana Lingala voice model: record the script, review takes,
freeze versioned datasets and keep a registry of training runs on Vertex AI.

Angular 20 (standalone, zoneless, signals) · Firebase Auth · Firestore · Cloud Storage.

## One-time Firebase setup (console)

Project: **koyokana-studio**

The existing default Firestore database uses **Standard** edition in **nam5**
(US multi-region).

1. **Authentication**: click **Get started**, then under **Sign-in method**, enable
   **Google** (support email: `mbadungoma@gmail.com`) and **Email/Password**.
   Alternatively, after logging into the Firebase CLI, run `npm run deploy:auth` to
   initialize Authentication and enable the providers configured in `firebase.json`.
   Under **Authentication → Settings → Authorized domains**, explicitly add `localhost`
   and `127.0.0.1` for local development; recent Firebase projects do not include
   `localhost` automatically. Use hostnames only, without a protocol or port.
   Add your hosting domain if you deploy elsewhere.
2. **Firestore Database → Create database** (production mode, region e.g. `us-central1` / `nam5`).
3. **Storage → Get started**. The default `*.firebasestorage.app` bucket needs the
   **Blaze** (pay-as-you-go) plan.
4. Install the CLI and deploy rules + indexes:

   ```bash
   npm i -g firebase-tools
   firebase login
   firebase deploy --only firestore:rules,firestore:indexes,storage
   ```

   The first Storage-rules deploy asks to let Storage read Firestore (roles live there) — accept.
5. Allow the browser to read audio for waveforms (playback works without it):

   ```bash
   gcloud storage buckets update gs://koyokana-studio.firebasestorage.app --cors-file=cors.json
   ```

## Run

```bash
npm install
npm start            # http://localhost:4200
```

Sign in with **mbadungoma@gmail.com** — that account becomes **admin** automatically
(Google sign-in, or email/password after verifying the address). Everyone else lands on
*Waiting for approval* until an admin approves them under **Team**.

The owner list lives in two places that must match:
`src/environments/environment.base.ts` → `ownerEmails` and `firestore.rules` → `isOwnerEmail()`.

## Roles

| Role | Can |
|---|---|
| admin | everything: script, datasets, training, team |
| reviewer | record + approve/reject/edit clips |
| recorder | record |
| pending / disabled | nothing (waiting screen) |

Enforced by `firestore.rules` and `storage.rules`, not just the UI.

## Data layout

| Where | What |
|---|---|
| `users/{uid}` | profile, role, speaker profile |
| `sentences/{id}` | script text, category, `seq`, status `open`/`recorded` |
| `clips/{id}` | one take: text, speaker, duration, QC report, review status |
| `daily/{YYYY-MM-DD}` | minutes/clips per day (Home chart) |
| `datasets/{name}` | frozen dataset metadata (immutable except notes) |
| `runs/{id}` | training run registry |
| `gs://…/recordings/{uid}/{clipId}.wav` | raw takes — 48 kHz, 24-bit, mono PCM |
| `gs://…/datasets/{name}/manifest.jsonl` | `{id, audio (gs://), text, speaker, duration, sample_rate, split}` per line |

Recording is captured raw through an AudioWorklet — echo cancellation, noise suppression and
auto-gain are switched off. Chrome gives the cleanest signal.

## Training flow

1. **Datasets → New dataset**: scan approved clips, freeze → `manifest.jsonl` in Storage.
2. **Training → Plan run**: pick the dataset, base model and GPU. The run drawer shows a
   ready-to-paste `gcloud ai custom-jobs create …` command. It expects a training image at
   `us-central1-docker.pkg.dev/koyokana-studio/koyokana/{tts|stt}-train:latest`.
3. Paste the Vertex AI job ID back into the run, then log WER/CER (STT) or MOS (TTS).

## Scripts

```bash
npm start                 # dev server against production Firebase
npm run emulators         # local Firebase emulators (Java required)
ng serve -c emulator      # dev server against the emulators
npm run test:rules        # security-rules tests (starts emulators; Java required)
npm test                  # unit tests (WAV encoder, QC analysis)
npm run deploy:auth       # initialize/configure Auth in koyokana-studio
npm run deploy            # build + firebase deploy (hosting, rules, indexes, auth)
```

If login returns `CONFIGURATION_NOT_FOUND`, the configured Firebase project has
not initialized Authentication. Run `npm run deploy:auth` (or complete step 1
above), then reload `/login`. An `auth/operation-not-allowed` error means the
selected provider still needs enabling; `auth/unauthorized-domain` means the
current hostname must be added to Authorized domains.

If sign-in succeeds but the account cannot load, create the **default** Firestore
database and deploy `firestore.rules`. Login stops waiting after 20 seconds and
shows the database error; it recovers automatically if the profile arrives later.
# koyokana-studio
