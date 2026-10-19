# First Lingala voice test

This is the `tts-train` image consumed by Studio's **Training → Plan run** command.
It runs one worker with one GPU, reads the frozen Studio JSONL manifest, and writes
private results under `gs://koyokana-studio.firebasestorage.app/runs/<run-id>/`.

Verified on October 19, 2026 on an actual NVIDIA L4: all 800 frozen clips prepared,
two optimizer steps completed at batch size 8, all 33 held-out clips evaluated,
43 prompts generated, and 119 WAVs plus the model/tokenizer and optimizer checkpoint
uploaded successfully. The released image is `v1.0.1`; 18 studio tests and nine
Python tests pass. This verifies execution, not voice quality after a full run.
The separate 100-epoch experiment remains planned and unlaunched.

## Correction to the original plan

`facebook/mms-tts-lin` is not a published checkpoint. Meta's [language coverage
table](https://dl.fbaipublicfiles.com/mms/misc/language_coverage_mms.html) lists
Lingala for ASR and language identification, but not TTS. This image instead uses
the published [UBC-NLP/Simba-TTS-lin](https://huggingface.co/UBC-NLP/Simba-TTS-lin)
Lingala MMS/VITS generator. The comparison voice is **UBC's original Lingala
voice**, not a Meta Lingala voice. The exact revisions are in `provenance.json`.

Training uses the pinned [Hugging Face VITS fine-tuning
recipe](https://github.com/ylacombe/finetune-hf-vits), with the architecture-compatible
English discriminator from Meta MMS. No other language replaces the Lingala
generator. The discriminator's CC-BY-NC-4.0 terms mean these artifacts are for
noncommercial research; resolve licensing before a commercial phone deployment.

## What the pipeline does

1. Requires exactly one speaker, unique clip IDs/URIs, and nonempty `train` and
   `eval` splits. Rejects duplicate transcripts, sentence IDs or identical audio
   crossing the split boundary. The held-back split is never used for gradients.
2. Downloads source objects with generation preconditions and records their
   generations, CRC32C checksums and SHA256 hashes. Original recordings are not
   changed. Resampling, silence trimming and gain use the same fixed rules on
   both splits, without learning any preprocessing parameters from evaluation.
3. Requires mono WAV input, removes DC offset, trims leading/trailing silence
   conservatively with 100 ms padding, resamples to 16 kHz, and targets -23 dBFS
   RMS with a -1 dBFS peak ceiling and at most 12 dB gain. This is RMS leveling,
   not a claim of broadcast LUFS mastering. Rejects silent, heavily clipped,
   nonfinite or out-of-range audio; a bad take stops the run with its clip ID.
4. Keeps original display transcripts and explicitly creates model transcripts:
   plain e/o, lowercase, accents transliterated, punctuation removed, numbers
   required as spoken words. The released tokenizer lacks `x` (taxi, deux);
   the training copy adds that symbol and resizes its embeddings. The original
   baseline remains unchanged, and sample metadata lists any baseline symbols
   it cannot represent. Both train and inference use the same transformation.
5. Fine-tunes generator and discriminator in float32 with the upstream GAN loss
   recipe. Refuses a missing CUDA GPU unless `--allow-cpu` is explicit. Stops on
   nonfinite losses. Defaults: 100 epochs, learning rate 0.00002, batch size 8,
   seed 456. These are starting settings, not a guarantee of voice quality.
6. Saves optimizer/model checkpoints every 1,000 steps, backing them up before
   local pruning. Remote checkpoint directories are immutable and accumulate;
   include their storage cost when reviewing experiments. The first-run CLI
   starts fresh; automatic recovery/resumption is not implemented.
7. Reloads the final generator for inference. Produces **every held-back
   sentence**, plus up to ten new phone phrases absent from the entire dataset.
   Each held-back sentence has original-recording provenance, a processed real
   take, baseline speech, and trained speech. With 50 held-back sentences and
   ten new phrases this is 60 prompts, not the inconsistent "about 30" in the
   initial plan. No reference recording is fabricated for new phone phrases.

The adapters in `launch_vits.py` load the local frozen DatasetDict, provide
optional single-speaker IDs, and save metrics/checkpoints. They explicitly select
train/eval mode: the pinned upstream script does not switch out of the mode set
by `from_pretrained`. `patch_vits.py` applies checked source patches to handle
omitted optional speaker IDs and clear discriminator gradients after generator
updates, preventing those gradients from contaminating the following discriminator
update. Each run records source hashes.

## Cloud build and validation

The Docker context is **only this directory**. Both upload and Docker ignore
lists exclude everything except explicitly named training sources. No Firebase
browser key, local credentials, recordings or service-account keys enter the image.
The base model and discriminator download at build time; runtime Hugging Face
access is disabled. Training uses the Vertex worker's attached identity.

```sh
gcloud builds submit training/tts \
  --config=training/tts/cloudbuild.yaml \
  --service-account=projects/koyokana-studio/serviceAccounts/tts-builder@koyokana-studio.iam.gserviceaccount.com \
  --project=koyokana-studio --region=global
```

Cloud Build runs unit tests plus a synthetic, **real two-step GAN smoke test**:
audio preprocessing → train/eval → optimizer update → checkpoint save → final
model reload → 23 generated/reference WAVs. It checks that existing generator
embeddings actually changed and that the extended vocabulary was exported.
Synthetic tones prove mechanics only; listening to a voice trained on real takes
is still necessary. Release tags are applied only after this test passes.
Use a new `_TAG` for a future release; do not overwrite a version used by runs.

For a machine with Docker running, a local build/test is:

```sh
docker build -t koyokana-tts-test training/tts
docker run --rm --shm-size=2g --entrypoint=python koyokana-tts-test /app/smoke_test.py
```

## Cloud setup

Required APIs: `aiplatform.googleapis.com`, `artifactregistry.googleapis.com`,
`cloudbuild.googleapis.com`; `cloudquotas.googleapis.com` is used for quota checks.
The private Docker repository is `koyokana`, in `us-central1`.

Dedicated identities:

- `tts-builder@koyokana-studio.iam.gserviceaccount.com`: viewer on the separate
  Cloud Build source bucket, writer on the `koyokana` container repository, and
  project log writer. It has no recording-bucket grants.
- `tts-trainer@koyokana-studio.iam.gserviceaccount.com`: bucket object viewer and
  object creator. It cannot delete or overwrite objects. Because this existing
  bucket uses fine-grained access, these grants apply to the whole bucket; they
  are not represented as prefix-scoped grants. The application enforces the
  `runs/<run-id>/` output prefix and uses create-only generation preconditions.

This avoids changing the existing bucket's ACL mode. IAM permissions for service
accounts bypass Firebase Storage Rules; those rules still protect Studio users.
Manifest downloads in Studio use authenticated `getBlob` requests, so manifests
created through the GCS API do not need public bearer download tokens. The bucket's
CORS configuration permits GET/HEAD from the existing trusted Studio origins in
`cors.json`. Authenticated download and browser preflight were verified, and an
anonymous request was denied.
G2/L4 availability is documented in [Google's compute compatibility
table](https://docs.cloud.google.com/vertex-ai/docs/training/configure-compute).
The relevant quota is **custom model training L4 GPUs**, not L4 serving quota.

On October 19, 2026, the L4 quota in `us-central1` was increased from zero to one.
Google approved `projects/303635763719/locations/global/quotaPreferences/koyokana-tts-l4`.
Check availability again before future runs; quota is distinct from GPU capacity.

## First real run

1. `tts-v1` was frozen on October 19, 2026: 800 approved, unflagged Edmond clips,
   52.9 minutes, 767 training clips and 33 evaluation clips. The deterministic
   grouped 5% target produced that actual held-out count. Manifest generation:
   `1792443774271937`. Future datasets should likewise select one speaker,
   exclude flagged takes, scan and freeze with sentence-grouped splits. Older
   datasets with leaking splits must be replaced, never silently reshuffled.
2. Confirm the L4 quota is granted and the tested `tts-train:v1.0.1` image is present.
3. Open **Training → tts-v1-r1**, which is already planned with `tts-v1`,
   **Simba Lingala (MMS / VITS)**, L4, 100 epochs, batch size 8, and learning rate
   0.00002. The full experiment has not been launched. For later experiments,
   use **Plan run**. Copy the generated command. The planned run retains the exact trainer image
   so a later release cannot silently change it. The command writes a JSON job spec with a dedicated
   training identity, 100 GB disk and **four-hour runtime limit**, then submits
   it to Vertex AI. The time limit bounds runtime, not a fixed dollar amount;
   builds, disks and artifact storage also cost money.
4. Paste the Vertex job ID into the run registry. Training does not update
   Firestore automatically; the registry status remains a manual entry.
5. Inspect `succeeded.json`, then listen to `samples/index.json` and its WAVs.
   A successful job proves execution, not that the trained voice is good.
   The Listen/scoring page is a separate step and is not implemented here.

Direct container arguments match Studio:

```text
--manifest=gs://koyokana-studio.firebasestorage.app/datasets/tts-v1/manifest.jsonl
--base-model=UBC-NLP/Simba-TTS-lin
--epochs=100 --learning-rate=0.00002 --batch-size=8
--output=gs://koyokana-studio.firebasestorage.app/runs/RUN_ID/
--run-id=RUN_ID
```

For a quick GPU mechanics check before full training, use a **new run ID** with
`--max-steps=1 --batch-size=1 --save-steps=1`. `--prepare-only` validates and
preprocesses data without training. `--allow-cpu` is for explicit local tests.
Rerunning against an existing output prefix fails instead of overwriting results.

## Output contract

```text
runs/<run-id>/
  run.json                    # arguments, exact upstream/model revisions, GPU
  input-manifest.jsonl        # exact input manifest
  preprocessing.json         # counts, source generations, hashes, per-clip changes
  training-config.json       # exact recipe passed to the trainer
  checkpoints/checkpoint-N/  # completed optimizer checkpoints
  model/                     # reloadable Hugging Face VITS model + tokenizer
  samples/index.json         # schema_version=1; sample text/type and private gs:// URIs
  samples/*.wav              # 16 kHz PCM16 mono; baseline/trained/real references
  metrics.jsonl              # training/eval losses, not human listening scores
  training.log
  succeeded.json             # uploaded last, only after all artifacts are present
```

`prepared.json` marks a preparation-only run. `failed.json` and `failure-*` logs
are best-effort failure diagnostics; a forcibly terminated worker may have only
Cloud Logging and its already uploaded checkpoints. Do not infer success from
the existence of a model folder. No MOS or intelligibility score is invented.

Ask 3–5 Kinshasa listeners to score intelligibility and Kinshasa naturalness 1–5,
and check recognizability separately. Continue recording toward ten hours only
after reviewing those results against the original UBC baseline.

The dated [validation record](validation.json) lists the immutable image, successful
build test, dataset snapshot, deployed studio checks, GPU verification job, and
separate planned full experiment. The GPU mechanics check uses only two optimizer
steps; it is not a completed voice-quality experiment.
