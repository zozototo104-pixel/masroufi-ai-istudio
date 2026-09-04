from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import Response
from pathlib import Path
from tempfile import TemporaryDirectory
import os
import sys
import subprocess
import threading
import numpy as np
import imageio_ffmpeg

VENDOR = Path(__file__).resolve().parent / "vendor" / "MOSS-TTS-Nano"
sys.path.insert(0, str(VENDOR))
from onnx_tts_runtime import OnnxTtsRuntime  # noqa: E402

app = FastAPI(title="Masroufi MOSS Voice Service")
_runtime = None
_runtime_lock = threading.Lock()


def get_runtime():
    global _runtime
    if _runtime is None:
        with _runtime_lock:
            if _runtime is None:
                _runtime = OnnxTtsRuntime(
                    thread_count=max(1, int(os.environ.get("MOSS_THREADS", "1"))),
                    max_new_frames=int(os.environ.get("MOSS_MAX_NEW_FRAMES", "375")),
                )
    return _runtime


@app.get("/health")
async def health():
    return {"ok": True, "provider": "moss-tts-nano-onnx", "loaded": _runtime is not None}


def browser_audio_to_wav(source: Path, target: Path) -> None:
    command = [
        imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-i", str(source),
        "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", str(target),
    ]
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=45)
    if result.returncode != 0:
        raise ValueError(result.stderr.decode("utf-8", errors="replace")[-500:])


def waveform_to_pcm24k_mono(waveform: np.ndarray, source_rate: int) -> bytes:
    audio = np.asarray(waveform, dtype=np.float32)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if source_rate == 48000:
        audio = audio[::2]
    elif source_rate != 24000:
        old_x = np.arange(audio.shape[0], dtype=np.float64)
        new_length = max(1, int(round(audio.shape[0] * 24000 / source_rate)))
        new_x = np.linspace(0, max(0, audio.shape[0] - 1), new_length)
        audio = np.interp(new_x, old_x, audio).astype(np.float32)
    return np.round(np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()


@app.post("/v1/tts")
async def tts(
    text: str = Form(...),
    reference_audio: UploadFile = File(...),
    format: str = Form("pcm"),
    sample_rate: int = Form(24000),
):
    if not text.strip():
        raise HTTPException(status_code=400, detail="text is required")
    if format != "pcm" or sample_rate != 24000:
        raise HTTPException(status_code=400, detail="only pcm/24000 is supported")
    reference = await reference_audio.read()
    if not reference:
        raise HTTPException(status_code=400, detail="reference audio is required")

    try:
        with TemporaryDirectory(prefix="masroufi-voice-") as tmp:
            source = Path(tmp) / "reference.input"
            prompt_wav = Path(tmp) / "reference.wav"
            output_wav = Path(tmp) / "generated.wav"
            source.write_bytes(reference)
            browser_audio_to_wav(source, prompt_wav)
            runtime = get_runtime()
            result = runtime.synthesize(
                text=text.strip(),
                prompt_audio_path=prompt_wav,
                output_audio_path=output_wav,
                streaming=False,
                max_new_frames=int(os.environ.get("MOSS_MAX_NEW_FRAMES", "375")),
                voice_clone_max_text_tokens=75,
                enable_wetext=False,
                enable_normalize_tts_text=False,
            )
            pcm = waveform_to_pcm24k_mono(result["waveform"], int(result["sample_rate"]))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"MOSS synthesis failed: {str(exc)[:500]}") from exc

    return Response(content=pcm, media_type="audio/pcm")
