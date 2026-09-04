# Masroufi MOSS Voice Service

Self-hosted OpenMOSS/MOSS-TTS-Nano ONNX voice-cloning service for Masroufi.

The service runs the official MOSS ONNX runtime directly. Browser recordings are converted to PCM WAV locally, and generated 48 kHz audio is converted to Masroufi's PCM16 mono 24 kHz playback format. Reference recordings are not persisted by this service; Masroufi stores them privately in Firebase Storage.

## Render deployment

Create a second Web Service from the `masroufi-ai` repository:

- Language: Python 3
- Branch: `main`
- Region: same region as Masroufi (Frankfurt)
- Root Directory: `moss-voice-service`
- Build Command: `bash build.sh`
- Start Command: `uvicorn app:app --host 0.0.0.0 --port $PORT`
- Compute: Free may be attempted first; MOSS ONNX model memory use can still exceed a 512 MB host.

Optional environment variables:

- `MOSS_THREADS=1`
- `MOSS_MAX_NEW_FRAMES=375`

The first synthesis initializes the ONNX runtime and downloads official model assets from Hugging Face if they are not already present in the build filesystem.

After deployment, set these on the main Masroufi service:

```text
CUSTOM_VOICE_PROVIDER=moss
MOSS_TTS_URL=https://<voice-service>.onrender.com
```

## Endpoints

- `GET /health`
- `POST /v1/tts` multipart: `text`, `reference_audio`, `format=pcm`, `sample_rate=24000`
- Response: raw PCM16 mono 24 kHz.
