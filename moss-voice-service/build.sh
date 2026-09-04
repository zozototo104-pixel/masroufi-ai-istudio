#!/usr/bin/env bash
set -euo pipefail
python -m pip install --upgrade pip
pip install -r requirements.txt
rm -rf vendor/MOSS-TTS-Nano
mkdir -p vendor
git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS-Nano.git vendor/MOSS-TTS-Nano
python - <<'PY'
from pathlib import Path
p = Path('vendor/MOSS-TTS-Nano/onnx_tts_runtime.py')
s = p.read_text()
s = s.replace('import torch\n', '').replace('import torchaudio\n', '')
start = s.index('    def _load_reference_audio(')
end = s.index('\n    def encode_reference_audio(', start)
replacement = '''    def _load_reference_audio(self, reference_audio_path: str | Path) -> np.ndarray:
        path = Path(reference_audio_path).expanduser().resolve()
        with wave.open(str(path), "rb") as wav_file:
            channels = int(wav_file.getnchannels())
            sample_width = int(wav_file.getsampwidth())
            sample_rate = int(wav_file.getframerate())
            frames = wav_file.readframes(wav_file.getnframes())
        if sample_width != 2:
            raise ValueError("Reference WAV must be PCM16")
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        audio = audio.reshape(-1, channels).T
        target_sample_rate = int(self.codec_meta["codec_config"]["sample_rate"])
        target_channels = int(self.codec_meta["codec_config"]["channels"])
        if sample_rate != target_sample_rate:
            old_x = np.arange(audio.shape[1], dtype=np.float64)
            new_length = max(1, int(round(audio.shape[1] * target_sample_rate / sample_rate)))
            new_x = np.linspace(0, max(0, audio.shape[1] - 1), new_length)
            audio = np.stack([np.interp(new_x, old_x, channel) for channel in audio], axis=0).astype(np.float32)
        if audio.shape[0] == 1 and target_channels > 1:
            audio = np.repeat(audio, target_channels, axis=0)
        elif audio.shape[0] > 1 and target_channels == 1:
            audio = audio.mean(axis=0, keepdims=True)
        elif audio.shape[0] != target_channels:
            raise ValueError(f"Unsupported reference audio channel conversion: {audio.shape[0]} -> {target_channels}")
        return audio[np.newaxis, ...].astype(np.float32, copy=False)
'''
s = s[:start] + replacement + s[end:]
p.write_text(s)
PY

# Download the official ONNX model assets during the Render build so the first
# user request does not pay the model-download cost after a free-instance wakeup.
python - <<'PY'
import sys
from pathlib import Path
repo = Path('vendor/MOSS-TTS-Nano').resolve()
sys.path.insert(0, str(repo))
from onnx_tts_runtime import ensure_browser_onnx_model_dir
path = ensure_browser_onnx_model_dir()
print(f'MOSS ONNX assets ready at: {path}')
PY
